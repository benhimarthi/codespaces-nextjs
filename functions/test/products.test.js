import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { firestoreDatabaseId } from "../src/utils/firestoreDatabase.js";

const projectId = process.env.GCLOUD_PROJECT || "demo-auth-service";
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
const bucketName = process.env.FIREBASE_STORAGE_BUCKET ?? `${projectId}.appspot.com`;
const endpointByOperation = {
  createProduct: "/products/create",
  updateProduct: "/products/update",
  archiveProduct: "/products/archive",
  getMyProducts: "/products/mine",
  submitForReview: "/products/submit-for-review",
  createCategory: "/categories/create",
  updateCategory: "/categories/update",
  setCategoryActive: "/categories/set-active",
  approveProduct: "/moderation/approve",
  rejectProduct: "/moderation/reject",
};
const app = getApps().length
  ? getApps()[0]
  : initializeApp({ projectId, storageBucket: bucketName });
const adminAuth = getAuth(app);
const adminDb = getFirestore(app, firestoreDatabaseId);
const adminBucket = getStorage(app).bucket(bucketName);
let accountNumber = 0;

async function createAccount(role = "user", mfa = false, options = {}) {
  accountNumber += 1;
  const email = `product-${accountNumber}-${randomUUID()}@example.test`;
  const user = await adminAuth.createUser({
    email,
    emailVerified: options.emailVerified ?? true,
  });
  await adminDb.collection("users").doc(user.uid).set({
    displayName: "Product test user",
    role,
    disabled: options.profileDisabled ?? false,
    deleted: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (role !== "user" || mfa) {
    await adminAuth.setCustomUserClaims(user.uid, {
      role,
      ...(mfa ? { sign_in_second_factor: "phone" } : {}),
    });
  }

  const customToken = await adminAuth.createCustomToken(user.uid);
  const response = await fetch(
    `http://${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  assert.equal(response.ok, true, "Auth emulator sign-in should succeed");
  return { uid: user.uid, token: (await response.json()).idToken };
}

async function invoke(name, data = {}, token, extraHeaders = {}) {
  const response = await fetch(
    `http://${functionsHost}/${projectId}/us-central1/productService${endpointByOperation[name] ?? name}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(data),
    },
  );
  const body = await response.json();
  return {
    status: response.status,
    body: body.error ? body : { result: body },
  };
}

async function uploadImage(uid, token, name = randomUUID()) {
  const path = `products/${uid}/${name}.png`;
  const url = new URL(`http://${storageHost}/v0/b/${bucketName}/o`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", path);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "image/png",
    },
    body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  assert.ok(response.ok, `Storage emulator upload failed: ${response.status}`);
  return path;
}

function productInput({ categoryId, subCategoryId, image, ...overrides }) {
  return {
    name: "Handmade bowl",
    description: "A locally made ceramic bowl.",
    price: 1250,
    currency: "MAD",
    categoryId,
    subCategoryId,
    images: [image],
    stock: 4,
    ...overrides,
  };
}

async function categoryPair(admin) {
  const categoryResponse = await invoke("createCategory", { name: "Home goods" }, admin.token);
  assert.equal(categoryResponse.status, 200, JSON.stringify(categoryResponse.body));
  const subResponse = await invoke("createCategory", {
    name: "Ceramics",
    parentId: categoryResponse.body.result.category.id,
  }, admin.token);
  assert.equal(subResponse.status, 200, JSON.stringify(subResponse.body));
  return {
    categoryId: categoryResponse.body.result.category.id,
    subCategoryId: subResponse.body.result.category.id,
  };
}

async function createProduct(owner, categories, data = {}) {
  const {
    image: suppliedImage,
    submitForReview = false,
    requestId,
    ...fields
  } = data;
  const image = suppliedImage ?? await uploadImage(owner.uid, owner.token);
  const input = productInput({ ...categories, image, ...fields });
  const response = await invoke("createProduct", {
    ...input,
    requestId: requestId ?? randomUUID(),
    ...(submitForReview ? { submitForReview: true } : {}),
  }, owner.token);
  return { response, input, image };
}

async function firestoreRequest(path, token, method = "GET", body) {
  return fetch(
    `http://${firestoreHost}/v1/projects/${projectId}/databases/${firestoreDatabaseId}/documents${path}`,
    {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}

test("all product, category, and moderation endpoints require authentication", async () => {
  for (const name of [
    "createProduct",
    "updateProduct",
    "archiveProduct",
    "getMyProducts",
    "submitForReview",
    "createCategory",
    "updateCategory",
    "setCategoryActive",
    "approveProduct",
    "rejectProduct",
  ]) {
    const response = await invoke(name);
    assert.equal(response.status, 401, `${name}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.status, "UNAUTHENTICATED");
  }
});

test("all product endpoints share one HTTP function and unknown routes are not exposed", async () => {
  const seller = await createAccount();
  const unknownRoute = await fetch(
    `http://${functionsHost}/${projectId}/us-central1/productService/products/unknown`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  assert.equal(unknownRoute.status, 404);
  const wrongMethod = await fetch(
    `http://${functionsHost}/${projectId}/us-central1/productService/products/mine`,
    { method: "GET", headers: { authorization: `Bearer ${seller.token}` } },
  );
  assert.equal(wrongMethod.status, 404);
});

test("strict validation rejects server fields, malformed values, and bad image paths", async () => {
  const admin = await createAccount("admin", true);
  const seller = await createAccount();
  const secondSeller = await createAccount();
  const matureCreatedAt = Timestamp.fromMillis(Date.now() - 8 * 86_400_000);
  await Promise.all([seller.uid, secondSeller.uid].map((uid) =>
    adminDb.collection("users").doc(uid).update({ createdAt: matureCreatedAt }),
  ));
  const categories = await categoryPair(admin);
  const image = await uploadImage(seller.uid, seller.token);
  const secondImage = await uploadImage(secondSeller.uid, secondSeller.token);
  const valid = productInput({ ...categories, image });
  const secondValid = productInput({ ...categories, image: secondImage });

  const invalidCases = [
    [seller, valid, { sellerId: seller.uid, status: "active", slug: "forged", ratingAvg: 5 }],
    [seller, valid, { price: 1.5 }],
    [seller, valid, { price: 0 }],
    [seller, valid, { price: -1 }],
    [seller, valid, { price: 100_000_001 }],
    [seller, valid, { stock: 1_000_001 }],
    [seller, valid, { currency: "XXX" }],
    [secondSeller, secondValid, { images: ["https://example.test/image.png"] }],
    [secondSeller, secondValid, { images: [`products/${seller.uid}/image.png`] }],
    [secondSeller, secondValid, { name: "This <b>is</b> HTML" }],
    [secondSeller, secondValid, { compareAtPrice: secondValid.price }],
  ];

  for (const [owner, product, overrides] of invalidCases) {
    const response = await invoke("createProduct", {
      ...product,
      ...overrides,
      requestId: randomUUID(),
    }, owner.token);
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }

  const missingFile = await invoke("createProduct", {
    ...valid,
    images: [`products/${seller.uid}/missing.png`],
    requestId: randomUUID(),
  }, seller.token);
  assert.equal(missingFile.status, 400);
});

test("product creation is idempotent, creates a server slug, and paginates up to 50", async () => {
  const admin = await createAccount("admin", true);
  const seller = await createAccount();
  const categories = await categoryPair(admin);
  const image = await uploadImage(seller.uid, seller.token);
  const requestId = randomUUID();
  const input = productInput({ ...categories, image });

  const first = await invoke("createProduct", { ...input, requestId }, seller.token);
  const retry = await invoke("createProduct", { ...input, requestId }, seller.token);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(first.body.result.product.id, retry.body.result.product.id);
  assert.equal(first.body.result.product.status, "draft");
  assert.equal(first.body.result.product.version, 1);
  assert.match(first.body.result.product.slug, /^handmade-bowl(?:-\d+)?$/);
  assert.equal(Object.hasOwn(first.body.result.product, "ratingAvg"), false);

  const duplicateRequest = await invoke("createProduct", {
    ...input,
    price: input.price + 1,
    requestId,
  }, seller.token);
  assert.equal(duplicateRequest.status, 409);

  const second = await invoke("createProduct", {
    ...input,
    name: "Handmade plate",
    requestId: randomUUID(),
  }, seller.token);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const page = await invoke("getMyProducts", { pageSize: 1 }, seller.token);
  assert.equal(page.status, 200);
  assert.equal(page.body.result.products.length, 1);
  assert.equal(typeof page.body.result.nextPageToken, "string");
  const next = await invoke("getMyProducts", {
    pageSize: 50,
    pageToken: page.body.result.nextPageToken,
  }, seller.token);
  assert.equal(next.status, 200);
  assert.equal(next.body.result.products.length, 1);
  assert.equal((await invoke("getMyProducts", { pageSize: 51 }, seller.token)).status, 400);
});

test("ownership checks conceal products; update uses versions and sensitive edits requeue review", async () => {
  const admin = await createAccount("admin", true);
  const seller = await createAccount();
  const otherSeller = await createAccount();
  const categories = await categoryPair(admin);
  const created = await createProduct(seller, categories, { submitForReview: true });
  assert.equal(created.response.status, 200, JSON.stringify(created.response.body));
  const productId = created.response.body.result.product.id;

  for (const name of ["updateProduct", "archiveProduct"]) {
    const response = await invoke(name, name === "updateProduct"
      ? { productId, expectedVersion: 1, price: 2000 }
      : { productId }, otherSeller.token);
    assert.equal(response.status, 404, JSON.stringify(response.body));
  }

  const approved = await invoke("approveProduct", { productId }, admin.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const stale = await invoke("updateProduct", {
    productId,
    expectedVersion: 1,
    price: 1500,
  }, seller.token);
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error.status, "FAILED_PRECONDITION");

  const edited = await invoke("updateProduct", {
    productId,
    expectedVersion: 2,
    price: 1500,
  }, seller.token);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.result.product.status, "pending_review");
  assert.equal(edited.body.result.product.version, 3);
  const statusAudit = await adminDb.collection("auditLogs")
    .where("targetId", "==", productId)
    .where("action", "==", "product_status_forced_by_update")
    .get();
  assert.equal(statusAudit.size, 1);
  const reapproved = await invoke("approveProduct", { productId }, admin.token);
  assert.equal(reapproved.status, 200, JSON.stringify(reapproved.body));
  const archived = await invoke("archiveProduct", { productId }, seller.token);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.result.product.status, "archived");
  assert.equal((await adminDb.collection("products").doc(productId).get()).exists, true);
});

test("subcategory integrity, review rejection, and category deactivation flag linked products", async () => {
  const admin = await createAccount("admin", true);
  const seller = await createAccount();
  const categories = await categoryPair(admin);
  const otherPair = await categoryPair(admin);
  const updateCategory = await invoke("updateCategory", {
    categoryId: otherPair.categoryId,
    name: "Home collection",
  }, admin.token);
  assert.equal(updateCategory.status, 200, JSON.stringify(updateCategory.body));
  const categoryAudits = await adminDb.collection("auditLogs")
    .where("targetId", "==", otherPair.categoryId)
    .where("action", "in", ["category_create", "category_update"])
    .get();
  assert.equal(categoryAudits.size, 2);

  const image = await uploadImage(seller.uid, seller.token);
  const wrongPair = await invoke("createProduct", {
    ...productInput({ ...categories, image }),
    categoryId: otherPair.categoryId,
    requestId: randomUUID(),
  }, seller.token);
  assert.equal(wrongPair.status, 412);
  assert.equal(wrongPair.body.error.status, "FAILED_PRECONDITION");

  const pending = await createProduct(seller, categories, { submitForReview: true });
  const productId = pending.response.body.result.product.id;
  const shortReason = await invoke("rejectProduct", { productId, reason: "No" }, admin.token);
  assert.equal(shortReason.status, 400);
  const rejected = await invoke("rejectProduct", {
    productId,
    reason: "The description needs more detail.",
  }, admin.token);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.result.product.status, "rejected");
  const rejectAudit = await adminDb.collection("auditLogs")
    .where("targetId", "==", productId)
    .where("action", "==", "product_reject")
    .get();
  assert.equal(rejectAudit.size, 1);
  const reset = await invoke("updateProduct", {
    productId,
    expectedVersion: 2,
    stock: 6,
  }, seller.token);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.result.product.status, "draft");

  const draft = await createProduct(seller, categories);
  const draftId = draft.response.body.result.product.id;
  const deactivated = await invoke("setCategoryActive", {
    categoryId: categories.subCategoryId,
    active: false,
  }, admin.token);
  assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
  const flagged = await adminDb.collection("products").doc(draftId).get();
  assert.equal(flagged.get("needsReview"), true);
  assert.equal(flagged.get("moderationStatus"), "review_required");
  const audit = await adminDb.collection("auditLogs")
    .where("targetId", "==", categories.subCategoryId)
    .where("action", "==", "category_deactivate")
    .get();
  assert.equal(audit.size, 1);
});

test("slug and seller SKU reservations remain unique under concurrent creates", async () => {
  const admin = await createAccount("admin", true);
  const seller = await createAccount();
  const categories = await categoryPair(admin);
  const activeCategory = await firestoreRequest(`/categories/${categories.categoryId}`);
  assert.equal(activeCategory.status, 200);
  const inactiveCategoryResult = await invoke("createCategory", {
    name: "Hidden category",
    active: false,
  }, admin.token);
  assert.equal(inactiveCategoryResult.status, 200);
  const hiddenCategory = await firestoreRequest(
    `/categories/${inactiveCategoryResult.body.result.category.id}`,
  );
  assert.equal(hiddenCategory.status, 403);
  const image = await uploadImage(seller.uid, seller.token);
  const sameName = await Promise.all(["slug-one", "slug-two"].map((sku) =>
    invoke("createProduct", {
      ...productInput({ ...categories, image, name: "Concurrent slug" }),
      sku,
      requestId: randomUUID(),
    }, seller.token),
  ));
  assert.deepEqual(sameName.map((response) => response.status), [200, 200]);
  assert.notEqual(
    sameName[0].body.result.product.slug,
    sameName[1].body.result.product.slug,
  );

  const sameSku = await Promise.all(["sku-one", "sku-two"].map((name) =>
    invoke("createProduct", {
      ...productInput({ ...categories, image, name }),
      sku: "SELLER-SKU",
      requestId: randomUUID(),
    }, seller.token),
  ));
  assert.equal(sameSku.filter((response) => response.status === 200).length, 1);
  const duplicate = sameSku.find((response) => response.status !== 200);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.status, "ALREADY_EXISTS");
});

test("pending quotas, inactive categories, status transitions, and create rate limits are enforced", async () => {
  const admin = await createAccount("admin", true);
  const seller = await createAccount();
  const categories = await categoryPair(admin);
  const image = await uploadImage(seller.uid, seller.token);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await invoke("createProduct", {
      ...productInput({ ...categories, image, name: `Pending item ${attempt}` }),
      requestId: randomUUID(),
      submitForReview: true,
    }, seller.token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const quota = await invoke("createProduct", {
    ...productInput({ ...categories, image, name: "Over quota" }),
    requestId: randomUUID(),
    submitForReview: true,
  }, seller.token);
  assert.equal(quota.status, 429);
  assert.equal(quota.body.error.status, "RESOURCE_EXHAUSTED");

  const transitionSeller = await createAccount();
  const draftImage = await uploadImage(transitionSeller.uid, transitionSeller.token);
  const draft = await createProduct(transitionSeller, categories, { image: draftImage });
  const draftId = draft.response.body.result.product.id;
  const invalidArchive = await invoke("archiveProduct", { productId: draftId }, transitionSeller.token);
  assert.equal(invalidArchive.status, 412);
  assert.equal(invalidArchive.body.error.status, "FAILED_PRECONDITION");
  const submitted = await invoke("submitForReview", { productId: draftId }, transitionSeller.token);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const submittedAgain = await invoke("submitForReview", { productId: draftId }, transitionSeller.token);
  assert.equal(submittedAgain.body.error.status, "FAILED_PRECONDITION");

  const inactive = await invoke("setCategoryActive", {
    categoryId: categories.subCategoryId,
    active: false,
  }, admin.token);
  assert.equal(inactive.status, 200, JSON.stringify(inactive.body));
  const inactiveCategoryProduct = await invoke("createProduct", {
    ...productInput({ ...categories, image: draftImage }),
    requestId: randomUUID(),
  }, transitionSeller.token);
  assert.equal(inactiveCategoryProduct.status, 412);
  assert.equal(inactiveCategoryProduct.body.error.status, "FAILED_PRECONDITION");

  const rateSeller = await createAccount();
  const rateImage = await uploadImage(rateSeller.uid, rateSeller.token);
  const rateCategories = await categoryPair(admin);
  let finalResponse;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    finalResponse = await invoke("createProduct", {
      ...productInput({ ...rateCategories, image: rateImage, name: `Rate item ${attempt}` }),
      requestId: randomUUID(),
    }, rateSeller.token);
    if (attempt < 5) assert.equal(finalResponse.status, 200);
  }
  assert.equal(finalResponse.status, 429);
  assert.equal(finalResponse.body.error.status, "RESOURCE_EXHAUSTED");
});

test("approval enforces the new seller active-product quota", async () => {
  const admin = await createAccount("admin", true);
  const seller = await createAccount();
  const categories = await categoryPair(admin);
  const batch = adminDb.batch();
  for (let index = 0; index < 10; index += 1) {
    batch.create(adminDb.collection("products").doc(`active-quota-${index}`), {
      sellerId: seller.uid,
      status: "active",
      categoryId: categories.categoryId,
      subCategoryId: categories.subCategoryId,
      version: 1,
    });
  }
  const pendingProductId = "active-quota-pending";
  batch.create(adminDb.collection("products").doc(pendingProductId), {
    sellerId: seller.uid,
    status: "pending_review",
    categoryId: categories.categoryId,
    subCategoryId: categories.subCategoryId,
    version: 1,
  });
  await batch.commit();

  const response = await invoke("approveProduct", { productId: pendingProductId }, admin.token);
  assert.equal(response.status, 429);
  assert.equal(response.body.error.status, "RESOURCE_EXHAUSTED");
});

test("unverified email and disabled account status prevent seller operations", async () => {
  const unverified = await createAccount("user", false, { emailVerified: false });
  const disabled = await createAccount();
  await adminAuth.updateUser(disabled.uid, { disabled: true });

  const unverifiedResult = await invoke("getMyProducts", {}, unverified.token);
  assert.equal(unverifiedResult.status, 403);
  const disabledResult = await invoke("getMyProducts", {}, disabled.token);
  assert.ok([401, 403].includes(disabledResult.status));
});

test("admin functions enforce role and MFA and audit successful moderation", async () => {
  const admin = await createAccount("admin", true);
  const noMfa = await createAccount("admin");
  const user = await createAccount();
  const categories = await categoryPair(admin);
  const created = await createProduct(user, categories, { submitForReview: true });
  const productId = created.response.body.result.product.id;

  for (const [name, body] of [
    ["createCategory", { name: "Denied category" }],
    ["updateCategory", { categoryId: categories.categoryId, name: "Denied update" }],
    ["setCategoryActive", { categoryId: categories.categoryId, active: false }],
    ["approveProduct", { productId }],
    ["rejectProduct", { productId, reason: "Moderation reason is sufficiently long." }],
  ]) {
    const response = await invoke(name, body, user.token);
    assert.equal(response.status, 403, `${name}: ${JSON.stringify(response.body)}`);
  }
  const categoryWithoutMfa = await invoke("createCategory", {
    name: "Category without MFA",
  }, noMfa.token);
  if (process.env.PRODUCT_CATEGORY_MFA_REQUIRED === "false") {
    assert.equal(categoryWithoutMfa.status, 200, JSON.stringify(categoryWithoutMfa.body));
    const categoryId = categoryWithoutMfa.body.result.category.id;
    const updatedWithoutMfa = await invoke("updateCategory", {
      categoryId,
      name: "Category updated without MFA",
    }, noMfa.token);
    assert.equal(updatedWithoutMfa.status, 200, JSON.stringify(updatedWithoutMfa.body));
    const deactivatedWithoutMfa = await invoke("setCategoryActive", {
      categoryId,
      active: false,
    }, noMfa.token);
    assert.equal(deactivatedWithoutMfa.status, 200, JSON.stringify(deactivatedWithoutMfa.body));
  } else {
    assert.equal(categoryWithoutMfa.status, 403);
  }
  const missingMfa = await invoke("approveProduct", { productId }, noMfa.token);
  assert.equal(missingMfa.status, 403);

  const approved = await invoke("approveProduct", { productId }, admin.token, {
    "x-request-id": randomUUID(),
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const audits = await adminDb.collection("auditLogs")
    .where("targetId", "==", productId)
    .where("action", "==", "product_approve")
    .get();
  assert.equal(audits.size, 1);
  assert.ok(audits.docs[0].get("actorUid"));
});

test("Firestore rules permit only public active reads and owner reads, never client writes", async () => {
  const admin = await createAccount("admin", true);
  const owner = await createAccount();
  const stranger = await createAccount();
  const categories = await categoryPair(admin);
  const image = await uploadImage(owner.uid, owner.token);
  const publicProduct = await createProduct(owner, categories, { image, submitForReview: true });
  const productId = publicProduct.response.body.result.product.id;
  await invoke("approveProduct", { productId }, admin.token);
  const privateProductRef = adminDb.collection("products").doc("private-rules-fixture");
  await privateProductRef.set({
    sellerId: owner.uid,
    status: "draft",
    name: "Private fixture",
  });

  const publicRead = await firestoreRequest(`/products/${productId}`);
  assert.equal(publicRead.status, 200);
  const ownerRead = await firestoreRequest(`/products/private-rules-fixture`, owner.token);
  assert.equal(ownerRead.status, 200);
  const strangerRead = await firestoreRequest(`/products/private-rules-fixture`, stranger.token);
  assert.equal(strangerRead.status, 403);
  const clientWrite = await firestoreRequest(
    "/products/client-write",
    owner.token,
    "PATCH",
    { fields: { status: { stringValue: "active" } } },
  );
  assert.equal(clientWrite.status, 403);
  const categoryWrite = await firestoreRequest(
    "/categories/client-write",
    owner.token,
    "PATCH",
    { fields: { active: { booleanValue: true } } },
  );
  assert.equal(categoryWrite.status, 403);
});

test("Storage rules enforce owner folder, image type/size, and create-only uploads", async () => {
  const owner = await createAccount();
  const other = await createAccount();
  const imagePath = await uploadImage(owner.uid, owner.token);

  const overwriteUrl = new URL(`http://${storageHost}/v0/b/${bucketName}/o`);
  overwriteUrl.searchParams.set("uploadType", "media");
  overwriteUrl.searchParams.set("name", imagePath);
  const overwrite = await fetch(overwriteUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.token}`,
      "content-type": "image/png",
    },
    body: Buffer.from([1]),
  });
  assert.equal(overwrite.status, 403);

  const foreignUrl = new URL(`http://${storageHost}/v0/b/${bucketName}/o`);
  foreignUrl.searchParams.set("uploadType", "media");
  foreignUrl.searchParams.set("name", `products/${owner.uid}/foreign.png`);
  const foreign = await fetch(foreignUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${other.token}`,
      "content-type": "image/png",
    },
    body: Buffer.from([1]),
  });
  assert.equal(foreign.status, 403);

  const invalidTypeUrl = new URL(`http://${storageHost}/v0/b/${bucketName}/o`);
  invalidTypeUrl.searchParams.set("uploadType", "media");
  invalidTypeUrl.searchParams.set("name", `products/${owner.uid}/bad.txt`);
  const invalidType = await fetch(invalidTypeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.token}`,
      "content-type": "text/plain",
    },
    body: Buffer.from("not an image"),
  });
  assert.equal(invalidType.status, 403);

  const [stored] = await adminBucket.file(imagePath).exists();
  assert.equal(stored, true);
  const publicRead = await fetch(
    `http://${storageHost}/v0/b/${bucketName}/o/${encodeURIComponent(imagePath)}`,
  );
  assert.equal(publicRead.status, 403);
  const publicList = await fetch(
    `http://${storageHost}/v0/b/${bucketName}/o?prefix=products%2F`,
  );
  assert.equal(publicList.status, 403);
});
