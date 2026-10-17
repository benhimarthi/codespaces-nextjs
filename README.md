# Codespaces Next.js authentication service

This repository includes Firebase Cloud Functions v2 HTTP auth and product
services in `functions/src/`, plus Firestore and Storage rules. The Functions
package is JavaScript (Node.js 22); Firebase Admin SDK calls use function
service-account identities and do not require downloaded service-account keys.

## Assumptions and configuration

- The Firebase project ID is selected in `.firebaserc` or with the Firebase
  CLI `--project` option; it is not configured in a Functions environment file.
- The auth service uses the existing Firestore database
  `ai-studio-1a058e78-fda1-403c-bc1b-85c0814c2690` in that project instead
  of the `(default)` database. Firebase Auth remains attached to the selected
  project.
- The example allowed origin is `http://localhost:3000`. Replace it with the
  exact trusted browser origins before using a deployed environment.
- Admin routes accept target UIDs and authorize access against verified role
  claims. They return explicit DTOs rather than raw Auth records and never
  return tokens, passwords, or password-reset links.
- A profile is `users/{uid}` with `displayName` and `createdAt`. Account
  deletion recursively removes that document and its subcollections. This
  service does not use Cloud Storage for user data.
- Firebase Admin uses workload identity/IAM. The public Firebase Web API key
  is used only to trigger Auth password-setup/reset email delivery.

Copy `functions/.env.example` to `functions/.env` and set the comma-separated
exact origins. Select the Firebase project in `.firebaserc` or with the Firebase
CLI `--project` option. Do not commit `functions/.env`.

## Functions

The single `authService` HTTP function exposes these routes under
`https://us-central1-<PROJECT_ID>.cloudfunctions.net/authService`:

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/register` | Creates the caller's profile once and assigns the default `user` custom claim if no supported role claim exists. |
| `POST` | `/role` | Admin-only compatibility route; applies the same hierarchy, MFA, recent-login, audit, and reason checks as `/admin/users/set-role`. |
| `GET` | `/profile` | Returns the caller's own profile fields only. |
| `DELETE` | `/account` | Recursively deletes the caller's profile subtree and deletes the caller's Auth account. |
| `POST` | `/admin/users/list` | Lists users with a page token, up to 100 per page, and optional role, disabled, and creation-time filters. |
| `POST` | `/admin/users/get` | Returns a whitelisted profile and Auth metadata for a UID. |
| `POST` | `/admin/users/set-role` | Changes `user`, `admin`, or `superadmin`; requires a reason and recent login. |
| `POST` | `/admin/users/disable` | Disables a lower-ranked account; requires a reason. |
| `POST` | `/admin/users/enable` | Enables a lower-ranked account. |
| `POST` | `/admin/users/revoke-sessions` | Revokes a lower-ranked account's refresh tokens. |
| `POST` | `/admin/users/delete` | Soft-deletes by default. Hard delete is superadmin-only; both require a reason and recent login. |
| `POST` | `/admin/users/create` | Creates an account with an authorized role and emails a password-setup link; requires recent login. |
| `POST` | `/admin/users/password-reset` | Sends a password-reset email without returning the link; requires recent login. |
| `POST` | `/admin/users/bulk-disable` | Disables at most 50 lower-ranked accounts in one request; requires a reason. |
| `POST` | `/admin/audit-logs/list` | Reads paginated, filterable audit entries through the Admin SDK. |

Each request must include the caller's Firebase ID token in the
`Authorization` header as `Bearer <ID_TOKEN>`. App Check verification is
currently disabled, so the `X-Firebase-AppCheck` header is not required. Routes
use strict Zod schemas, reject unknown input fields, and enforce role checks
using the verified `role` custom claim; a missing claim is treated as the
baseline `user` role. All admin operations require MFA and are rate-limited per
admin UID. Sensitive changes require an authentication time within five
minutes. Role and disable changes update role-only custom claims and revoke
refresh tokens. Audit entries are append-only and include outcome, request ID,
reason, and IP, never credentials or reset links. Send `X-Request-Id` to make
account-creation retries idempotent; use a UUID value for that header.

Clients should call the HTTP routes with `fetch` and a Firebase ID token; they
are not `httpsCallable` functions. For example, registration is
`POST /register` with a JSON body such as `{"displayName":"Example"}`.

## Product module

All product, category, and moderation operations are served by one Firebase
Functions v2 HTTP function, `productService`. Each operation has a separate
authenticated `POST` route. The service verifies Firebase ID tokens from the
`Authorization: Bearer <ID_TOKEN>` header. Admin routes require MFA and a
five-minute recent login. Routes use strict Zod schemas, rate limits, and
explicit response DTOs. App Check is not enabled.

Temporary exception: in `next-3d-scene`, MFA is disabled only for category
create/update/activation routes by `PRODUCT_CATEGORY_MFA_REQUIRED=false`.
Those routes still require an admin role and authentication within five
minutes. Moderation and all other admin routes still require MFA. Remove this
project override (the code defaults back to requiring MFA) when category setup
is complete.

Base URL:

```text
https://us-central1-<PROJECT_ID>.cloudfunctions.net/productService
```

| Route | Access | Behavior |
| --- | --- | --- |
| `POST /products/create` | Authenticated seller | Creates a draft, or pending-review product when `submitForReview` is true. Requires a UUID `requestId`; identical retries return the same product. |
| `POST /products/update` | Product owner | Partial content update requiring `expectedVersion`. Price, image, category, or variant edits on an active product return it to review. |
| `POST /products/archive` | Product owner | Soft archives an active product; never deletes the document. |
| `POST /products/mine` | Authenticated seller | Returns only the caller's products, with status filter, page token, and page size capped at 50. |
| `POST /products/submit-for-review` | Product owner | Transitions a draft to pending review. |
| `POST /categories/create` | Admin | Creates a root category or a subcategory through `parentId`; slug is generated and reserved server-side. |
| `POST /categories/update` | Admin | Updates category name, parent, and/or active state. |
| `POST /categories/set-active` | Admin | Deactivation flags products referencing the category for review before completing. |
| `POST /moderation/approve` | Admin | Transitions a pending-review product to active, subject to seller active-product limits. |
| `POST /moderation/reject` | Admin | Transitions a pending-review product to rejected and records a reason of at least 10 characters. |

Categories and products are read directly from Firestore. Public reads are
limited by rules to active categories and active products; owners may read
their own products. Client writes to product/category documents and audit logs
are always denied. Storage allows only create-only image uploads beneath the
authenticated owner's `products/{uid}/` prefix; public reads and listing are
not allowed.

### Product lifecycle

```text
draft --seller submits or creates directly--> pending_review
pending_review --admin approves--> active
pending_review --admin rejects (reason required)--> rejected
rejected --seller edits--> draft
active --seller archives--> archived
active --price/images/category/variant edit--> pending_review
category deactivation --linked products--> needsReview=true (status unchanged)
```

The `active -> pending_review` edit path is the explicit re-review exception
for sensitive active-product changes. Other status changes are rejected.
Deactivation keeps the existing product status intact and flags each linked
product; it does not silently delete or archive products.

### Product role matrix

| Role | Create/update/archive own products | Read own products | Create/update/deactivate categories | Approve/reject products |
| --- | --- | --- | --- | --- |
| `user` | Yes | Yes | No | No |
| `admin` | Yes | Yes | Yes (MFA and recent login) | Yes (MFA and recent login) |
| `superadmin` | Yes | Yes | Yes (inherits admin) | Yes (inherits admin) |

Unauthenticated callers are denied. Sellers must have a verified email, an
enabled Auth account, and an enabled/non-deleted Firestore profile. All owner
checks use the verified caller UID and return not-found for another seller's
product. The client cannot set seller, status, moderation, slug, timestamps,
rating, sales, or version fields.

### Product limits and defaults

These are implementation defaults for values unspecified in the product
requirements; adjust them through a reviewed code/config change before
production use.

| Limit | Default |
| --- | --- |
| Accepted currencies | `MAD`, `EUR`, `XOF`, `USD`, `GBP` |
| Price | Integer minor units, minimum 1, maximum 100,000,000 |
| Stock | Integer 0–1,000,000 |
| Images | 1–8 Storage paths; JPEG, PNG, or WebP; maximum 5 MiB each |
| Payload | 100 KiB maximum |
| Pending-review products | 5 per seller; 2 for accounts younger than 7 days |
| Active products | 100 per seller; 10 for accounts younger than 7 days |
| Product strings | Name 3–120; description at most 5,000; brand at most 80; SKU at most 64; tags at most 10 and 30 characters each |
| Variants | At most 50; each has 1–8 attributes, attribute keys/values at most 40 characters; no duplicate combinations |
| Dimensions and weight | Each positive integer dimension 1–10,000 mm; weight 1–100,000 g |
| Pagination | Default 20; maximum 50 |
| Rate limits (UID / IP per hour) | Create 10 / 30; update 30 / 90; archive 20 / 60; own-list read 120 / 240; submit 10 / 30 |
| Admin rate limits (UID / IP per hour) | Category create 10 / 30; category update 20 / 60; category active 10 / 30; each moderation action 60 / 120 |
| Function capacity | One shared service: 3 instances maximum, 512 MiB, 120 seconds |

Accounts younger than seven days also receive half of each seller function's
per-UID rate limit (rounded down, minimum one request per window).

The product service inherits the exact origins in `ALLOWED_ORIGINS`; the
example remains `http://localhost:3000`. The bucket uses the value configured
by Firebase unless `FIREBASE_STORAGE_BUCKET` is set. No product function
currently uses a secret, so no secret value is provided or bound.

## Admin role matrix and bootstrap

| Actor | Manage `user` | Manage `admin` | Manage `superadmin` | Assign roles |
| --- | --- | --- | --- | --- |
| `user` | No | No | No | None |
| `admin` | Yes | No | No | `user` only |
| `superadmin` | Yes | Yes | No | `user`, `admin`, or `superadmin` |

An actor cannot change their own role, disable themselves, or delete themselves.
Only a superadmin can hard-delete an account. The service prevents removal of
the last superadmin. Bootstrap the first superadmin only through the one-off
local Admin SDK script; no HTTP or callable bootstrap endpoint exists:

```sh
cd functions
export FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
export SUPERADMIN_EMAIL=admin@example.com
# Authenticate locally with ADC (gcloud auth application-default login).
npm run bootstrap:superadmin
```

Run this from a trusted workstation with Application Default Credentials
authorized for the selected project. The script refuses to replace a different
existing superadmin and writes the role to Auth custom claims and the protected
Firestore profile. Never add a service-account key to the repository.

Password-setup and reset email delivery uses Firebase Authentication's
Identity Toolkit endpoint. Set `FIREBASE_WEB_API_KEY` in `functions/.env` to
the same Firebase Web API key used by the app; it is not an Admin SDK
credential. Configure the project's Auth email templates and authorized
domains before production use.

## Compromised admin incident procedure

1. From a trusted Admin SDK environment, disable the compromised Auth account
   and revoke its refresh tokens immediately.
2. Use a separate superadmin to demote the account to `user` or delete it.
   These actions are audited and revoke existing sessions.
3. Review `/admin/audit-logs/list` for the affected actor UID, including
   permission denials and role changes. Export matching Cloud Logging entries
   before retention expires.
4. Rotate credentials, verify MFA factors and recovery channels, and inspect
   recently created/modified accounts and access grants.
5. Restore access only after the owner has re-established MFA and the incident
   is contained. If no usable superadmin remains, recover from a trusted local
   Admin SDK environment—not an HTTP endpoint.

## Web authentication

The Next.js sign-in page supports email/password account creation and sign-in,
Google sign-in, and sign-out. Configure the Firebase Web app values in a local
`.env.local` file using `.env.example` as a template. These are Firebase client
configuration values, not Admin SDK credentials. In the Firebase console,
enable Email/Password and Google under Authentication > Sign-in method, and add
the deployed site domain to Authentication > Settings > Authorized domains.

Sensitive routes are rate-limited per UID and, when available, per client IP.
The auth service is capped at three instances to constrain admin-operation
capacity.
Only SHA-256-derived identity keys and counters are stored in the private
`_rateLimits` collection. Enable Firestore TTL for `_rateLimits.expiresAt`:

```sh
gcloud firestore fields ttls update expiresAt \
  --collection-group=_rateLimits --enable-ttl \
  --database=ai-studio-1a058e78-fda1-403c-bc1b-85c0814c2690 \
  --project=YOUR_PROJECT_ID
```

## Emulator development and tests

Requirements: Node.js 22 and npm.

```sh
npm install --prefix functions
cp functions/.env.example functions/.env
npm --prefix functions run build
npm --prefix functions run test:emulators
```

The test script runs Auth, Firestore, Functions, and Storage emulators under the
demo project ID `demo-auth-service`; it does not deploy. Tests cover route and
method handling, authentication, admin role hierarchy, MFA and recent-login
requirements, audit entries, pagination, rate limits, soft deletion, session
revocation, product lifecycle, quotas, ownership, idempotency, and Firestore/
Storage rules. Neither the HTTP auth service nor the product service requires
App Check.

## IAM and deployment

`infra/service-accounts.tf` creates a dedicated `auth-service` identity and
one `product-service` identity. The product service receives Firestore access,
Firebase Auth account-read access for seller eligibility checks, and Cloud
Storage object-read permission for image verification. It does not receive
Storage write or Secret Manager access.

Before deploying:

1. Select the real project ID in `.firebaserc` or with the Firebase CLI
   `--project` option, and set exact production origins in `functions/.env`.
2. Enable Firebase Authentication, Cloud Firestore, Cloud Functions, Cloud
   Build, Artifact Registry, and the Firebase App Check APIs as required by the
   project.
3. Provision the auth and product service accounts and IAM bindings from
   `infra/` with a trusted Terraform identity. Ensure the deployment identity
   can act as both configured function service accounts.
4. Enable the Firestore TTL policy above and configure App Check for the client
   application.
5. Bootstrap the first superadmin with the local Admin SDK script above; never
   accept admin claims from client input.
6. Review the security checklist below and run the emulator suite.

Create Cloud Logging alerts for structured `admin_action` entries where a role
change assigns `admin` or `superadmin`, all `bulk_disable_users` actions, and
repeated `ADMIN_*_DENIED`, `ADMIN_INSUFFICIENT_ROLE`, or `ADMIN_MFA_REQUIRED`
events.

## Cart and orders module

Cart and order operations are grouped into two Firebase Functions v2 HTTP
services exported from `functions/src/`: `cartService` and `ordersService`.
Each operation has a fixed POST route; clients send a Firebase ID token as a
Bearer token and a JSON request body. The services use strict Zod validation,
authentication, the existing role hierarchy, rate-limit counters, and audit
collection. App Check is not enforced. CORS is restricted to the exact
comma-separated origins in `ALLOWED_ORIGINS`.

### Operations and role matrix

| Operation | Access | Behavior |
| --- | --- | --- |
| `cartService` — `POST /cart/add`, `/cart/update`, `/cart/remove`, `/cart/get`, `/cart/clear` | Active authenticated account / cart owner | Manages the caller's cart; reads current product availability and prices. |
| `ordersService` — `POST /orders/create`, `/orders/cancel`, `/orders/mine`, `/orders/get` | Verified active buyer | Creates, reads, and cancels only the caller's orders; supports only COD or pickup. |
| `ordersService` — `POST /seller/orders/*` | Seller who owns the sub-order | Seller authority is proven by the sub-order's `sellerId`; contact fields are redacted until confirmation. |
| `ordersService` — `POST /admin/orders/*` | `admin` or higher | Admin routes require MFA; force-cancel and dispute resolution also require authentication within five minutes and a reason of at least 10 characters. |
| `expireUnconfirmedOrders`, `completeDeliveredOrders` | Cloud Scheduler | Separate 15-minute jobs expire stale pending orders and complete delivered orders after their configured waiting period. |

For example, send `POST https://<region>-<project>.cloudfunctions.net/cartService/cart/add`
with `Authorization: Bearer <Firebase ID token>` and JSON
`{"productId":"…","quantity":1}`. Orders, seller, and admin routes use the
same `ordersService` base URL with their route prefixes above. The two scheduled
functions remain separate scheduler-triggered functions.

The seller's buyer contact data is stored separately from the seller-readable
order snapshot. Sellers can retrieve the buyer's name, phone, and delivery
address only when the sub-order is confirmed or later. Firestore rules also
gate the private contact document by its parent order status. Pickup-code
hashes are kept in server-only `orderSecrets`, never in buyer- or seller-
readable order documents.

### Cart and order data

`carts/{uid}/items/{lineId}` contains exactly `productId`, `variantId`, and
`quantity`. Price/availability are read from the current product on every cart
read and again at checkout. A client can submit line IDs and quantities, but
cannot set buyer/seller identity, prices, discount, fee, total, payment status,
or order status.

`orderGroups/{groupId}` tracks one idempotent checkout and the pending
sub-order count. Each `orders/{orderId}` is one seller-and-currency sub-order;
a cart spanning sellers or currencies is split accordingly. Product name,
image path, variant, unit price, currency, shipping fee, and line quantities
are snapshots. Inventory, order documents, idempotency receipts, order-number
reservations, and initial audit events are committed in one Firestore
transaction. Stock is restored transactionally on rejection, cancellation,
expiry, or failed delivery.

Amounts are safe integer minor units. COD shipping is a server-configured flat
fee per seller sub-order; pickup shipping is zero. `ORDER_SHIPPING_FEES` and
`ORDER_NEW_ACCOUNT_TOTAL_LIMITS` are JSON maps keyed by supported currency.
The example configures MAD only; add a fee and (for new-account checkout) a cap
for every other currency that the store intends to sell. Missing currency
configuration fails closed. Never populate these from callable input.

For a single-seller pickup, a buyer supplies `pickupLocationId`; when one
checkout spans sellers, the buyer supplies `pickupLocations` entries mapping
each `productId` to a `pickupLocationId`. The server derives the seller from
the product, checks the active
`users/{sellerUid}/pickupLocations/{pickupLocationId}` document, and snapshots
its `name` and `address`. All products in one seller/currency sub-order must
use the same pickup location. Seed/manage these documents through a trusted
server-side Admin SDK workflow; clients cannot write them. The buyer receives
an eight-digit pickup code only in the successful create response. Only its
hash is retained, and an idempotent retry deliberately does not reveal the
code again. Invalid pickup-code attempts are audited without recording the
submitted code.

The payment model stores `paymentMethod` plus a `payment` object containing
`method`, `status`, `provider`, `providerReference`, and `collectedAt`.
Currently only `cod` and `pickup` are accepted; both begin `unpaid`, and a
seller's delivered transition alone changes the status to `collected`. Future
online payments can add an allowed provider and authorization/capture/refund
metadata to `payment`, plus a provider webhook/verification path, without
changing order snapshots, seller sub-orders, or checkout totals. Do not mark
an order paid based on a client request.

### Order state machine

Each sub-order follows this server-enforced state machine. Admin force-cancel
is the explicit override for active states; all other transitions are checked
against the actor, payment method, required reason/code, and timing rule.

```text
pending_confirmation --seller--> confirmed --seller--> processing
        |                         |                       |
        | seller rejects          | buyer cancels         | COD
        | buyer cancels            | seller cancels        v
        | scheduler expires        +----------------> out_for_delivery
        |                                                 /       \
        |                                                v         v
        |                                          delivered   failed_delivery
        |                                                ^
        |                                                |
        | pickup: processing --> ready_for_pickup -------+
        |                         | correct buyer code
        |                         +-- after 3 days --> failed_delivery
        v
 rejected / cancelled / expired

 delivered --7 days, scheduler--> completed
 delivered --admin, reason-----> returned
 admin force-cancel: any active state --> cancelled
```

| From | To | Authorized actor and guard |
| --- | --- | --- |
| `pending_confirmation` | `confirmed`, `rejected` | Owning seller; rejection requires a reason. |
| `pending_confirmation` | `cancelled` | Buyer who owns the order. |
| `pending_confirmation` | `expired` | Scheduler after 48 hours. |
| `confirmed` | `processing` | Owning seller. |
| `confirmed` | `cancelled` | Buyer before processing, or owning seller with a reason. |
| `processing` | `out_for_delivery` | Owning seller, COD only. |
| `processing` | `ready_for_pickup` | Owning seller, pickup only. |
| `out_for_delivery` | `delivered`, `failed_delivery` | Owning seller, COD only; failure requires a reason. |
| `ready_for_pickup` | `delivered` | Owning seller with the correct one-time code. |
| `ready_for_pickup` | `failed_delivery` | Owning seller after 3 days; requires a reason. |
| `delivered` | `completed` | Scheduler after 7 days. |
| `delivered` | `returned` | Admin with MFA, fresh authentication, and a reason. |
| Active state | `cancelled` | Admin force-cancel with MFA, fresh authentication, and a reason. |

Every transition writes the order, inventory/counters where relevant, and an
append-only `auditLogs` record in the same transaction. The audit record
contains actor, role, action, order ID, before/after status, reason, server
timestamp, request ID, and IP; it excludes addresses, phone numbers, tokens,
and secrets.

### Fraud limits and configuration

| Rule | Default | Configuration / behavior |
| --- | --- | --- |
| Cart size | 20 distinct lines | `CART_MAX_ITEMS`; quantities aggregate per product/variant. |
| Per-line quantity | 10 | `CART_MAX_QUANTITY`, additionally bounded by current stock. |
| Pending checkouts | 3 | `ORDER_MAX_PENDING`; counts checkout groups, not individual seller sub-orders. |
| Orders per UTC day | 10 | `ORDER_MAX_PER_DAY`; counts checkout groups. |
| New-account age | 7 days | `ORDER_NEW_ACCOUNT_DAYS`. |
| New-account order cap | 2,000 MAD (200,000 minor units) | `ORDER_NEW_ACCOUNT_TOTAL_LIMITS`, per currency. |
| Reliability threshold | 3 failed deliveries or buyer cancellations after confirmation | `ORDER_RELIABILITY_STRIKES`; after the threshold COD is blocked and pickup remains available. |
| Pending confirmation expiry | 48 hours | `ORDER_UNCONFIRMED_EXPIRY_HOURS`. |
| Pickup failure | 3 days after ready | `ORDER_PICKUP_FAILURE_DAYS`. |
| Auto-completion | 7 days after delivery | `ORDER_AUTO_COMPLETE_DAYS`. |
| COD shipping | 30 MAD (3,000 minor units) per seller sub-order | `ORDER_SHIPPING_FEES`; pickup is always zero. |
| Cart rate limits | 60 per UID and 120 per IP per hour | `CART_RATE_PER_UID`, `CART_RATE_PER_IP`, `CART_RATE_WINDOW_SECONDS`. |
| Create-order rate limits | 5 per UID and 15 per IP per hour | `ORDER_CREATE_RATE_PER_UID`, `ORDER_CREATE_RATE_PER_IP`, `ORDER_CREATE_RATE_WINDOW_SECONDS`. |
| Buyer read rate limits | 120 per UID and 240 per IP per hour | `ORDER_READ_RATE_PER_UID`, `ORDER_READ_RATE_PER_IP`, `ORDER_READ_RATE_WINDOW_SECONDS`. |
| Buyer mutation rate limits | 10 per UID and 30 per IP per hour | `ORDER_MUTATION_RATE_PER_UID`, `ORDER_MUTATION_RATE_PER_IP`, `ORDER_MUTATION_RATE_WINDOW_SECONDS`. |
| Seller order rate limits | 60 per UID and 120 per IP per hour | `SELLER_ORDER_RATE_PER_UID`, `SELLER_ORDER_RATE_PER_IP`, `SELLER_ORDER_RATE_WINDOW_SECONDS`. |
| Admin read rate limits | 60 per UID and 120 per IP per hour | `ADMIN_ORDER_READ_RATE_PER_UID`, `ADMIN_ORDER_READ_RATE_PER_IP`, `ADMIN_ORDER_READ_RATE_WINDOW_SECONDS`. |
| Admin mutation rate limits | 20 per UID and 40 per IP per hour | `ADMIN_ORDER_MUTATION_RATE_PER_UID`, `ADMIN_ORDER_MUTATION_RATE_PER_IP`, `ADMIN_ORDER_MUTATION_RATE_WINDOW_SECONDS`. |

All rate-limit windows use seconds and the existing Firestore-backed
rate-limit helper. Enable TTL on the configured expiry fields as noted below.

Email must be verified. A Firebase Auth phone number, when present, must match
the submitted Moroccan phone number; Moroccan local and `+212` mobile formats
are accepted. Delivery addresses are limited to country code `MA`. Disabled
or deleted buyers and sellers are rejected.

Copy `functions/.env.example` to `functions/.env` and set exact origins and the
currency maps before emulator use or deployment. Keep `.env` out of source
control. Enable Firestore TTL for `_rateLimits.expiresAt` and
`_buyerDailyOrderCounts.expiresAt`:

```sh
gcloud firestore fields ttls update expiresAt \
  --collection-group=_rateLimits --enable-ttl \
  --database=ai-studio-1a058e78-fda1-403c-bc1b-85c0814c2690 \
  --project=YOUR_PROJECT_ID
gcloud firestore fields ttls update expiresAt \
  --collection-group=_buyerDailyOrderCounts --enable-ttl \
  --database=ai-studio-1a058e78-fda1-403c-bc1b-85c0814c2690 \
  --project=YOUR_PROJECT_ID
```

The functions package adds no dependencies for this module; it reuses Zod,
Firebase Admin/Functions, Node's crypto, and the existing shared middleware.
The deployed module services use the `store-cart` and `store-orders`
identities; scheduler jobs use `store-order-scheduler`. Module services need
Firestore access and read-only Firebase Auth account access; the scheduler
needs Firestore access only. These identities and least-privilege grants are
declared in `infra/service-accounts.tf`.

Before switching clients, point them to the HTTP routes above and send the
Firebase ID token in a Bearer authorization header. After validating the new
routes, delete any previously deployed per-operation cart/order callables to
avoid maintaining two API contracts.

Deployment commands:

```sh
terraform -chdir=infra init
# Provision auth, product, and store service identities:
terraform -chdir=infra apply \
  -target=google_project_iam_member.auth_service_auth \
  -target=google_project_iam_member.auth_service_firestore \
  -target=google_project_iam_member.product_firestore \
  -target=google_project_iam_member.product_seller_auth \
  -target=google_project_iam_member.product_storage_read \
  -target=google_project_iam_member.store_firestore \
  -target=google_project_iam_member.store_auth_read \
  -var="project_id=YOUR_PROJECT_ID"
npm --prefix functions run build
firebase deploy --only firestore --project=YOUR_PROJECT_ID
firebase deploy --only functions:cartService,functions:ordersService,functions:expireUnconfirmedOrders,functions:completeDeliveredOrders --project=YOUR_PROJECT_ID
# After confirming the module endpoints, remove legacy per-operation callables:
firebase functions:delete addToCart cancelMyOrder --region=us-central1 --project=YOUR_PROJECT_ID
# Retire obsolete service identities only after no deployed function uses them:
terraform -chdir=infra apply -var="project_id=YOUR_PROJECT_ID"
```

## Security checklist

- [ ] Select the intended project ID and replace the local-only CORS origin.
- [ ] Keep `functions/.env` and service-account credentials out of source
  control; prefer workload identity over downloaded keys.
- [ ] Confirm the auth service's service account and IAM grants match the
  Terraform configuration, and the deployer has only required `actAs` access.
- [ ] Enable Firestore TTL for `_rateLimits.expiresAt`.
- [ ] Do not enable App Check enforcement on the product service; assess
  enforcement for other client services separately.
- [ ] Bootstrap and audit administrators only through a trusted Admin SDK
  environment; rotate/remove claims when access changes.
- [ ] Keep Firestore and Storage rules deployed; direct client writes are denied.
- [ ] Add tests and explicit ownership checks before introducing new data
  collections or Storage paths.

## Notifications module

The `functions/src/notifications/` module is structured around a channel-neutral
notification engine and a pluggable adapter boundary.

### Directory map

```text
functions/src/notifications/
  service.js                 # single HTTP API endpoint: notificationService
  engine/
    dispatcher.js
    router.js
    templates.js
    retry.js
    dedupe.js
    channels/
      whatsapp.adapter.js
      whatsapp.mapper.js
      fcm.adapter.js
      email.adapter.js
      inapp.adapter.js
  callable/                   # shared operation implementations; not callable exports
    registerDeviceToken.js
    unregisterDeviceToken.js
    getMyNotifications.js
    markAsRead.js
    markAllAsRead.js
    updateNotificationPreferences.js
    linkWhatsAppNumber.js
    confirmWhatsAppLink.js
    unlinkWhatsAppNumber.js
  inbound/
    whatsappInboundHandler.js
  triggers/
    onOrderCreated.js
    onOrderStatusChanged.js
    onProductModerated.js
    onFraudRuleBlocked.js
  scheduled/
    remindSellerBeforeExpiry.js
    retryFailedNotifications.js
    cleanupOldNotifications.js
  shared/
    config.js
    schemas.js
    highValue.js
```

### Event recipient matrix

| Event | Seller | Buyer | Admin | Critical |
| --- | --- | --- | --- | --- |
| `order_created` | yes | no | no | yes |
| `order_confirmed` | no | yes | no | yes |
| `order_rejected` | no | yes | no | yes |
| `order_cancelled` | yes | yes | no | yes |
| `order_out_for_delivery` | no | yes | no | yes |
| `order_ready_for_pickup` | no | yes | no | yes |
| `order_delivered` | no | yes | no | yes |
| `order_expired` | no | yes | no | yes |
| `order_failed_delivery` | no | yes | no | yes |
| `seller_expiry_reminder` | yes | no | no | yes |
| `product_moderated` | yes | no | no | no |
| `admin_fraud_block` | no | no | yes | yes |
| `admin_repeated_failed_delivery` | no | no | yes | yes |
| `admin_high_value_order` | no | no | yes | yes |

### Channel routing table

| Event type | Primary | Fallback chain | In-app |
| --- | --- | --- | --- |
| default | WhatsApp | FCM → Email | always |
| order lifecycle and seller reminder events | WhatsApp | FCM → Email | always |
| product moderation | WhatsApp | FCM → Email | always |
| admin alerts | WhatsApp | FCM → Email | always |
| inbound interaction replies | WhatsApp | none | always |

### Inbound WhatsApp command table

| Command | Meaning | Confirmation required | Notes |
| --- | --- | --- | --- |
| `AIDE` / `HELP` | show commands | no | unknown text gets help only |
| `CONFIRMER <id>` | confirm a pending order transition | yes | action only after `OUI` |
| `REFUSER <id>` | reject order | yes | must reuse the existing order state machine |
| `EXPEDIER <id>` | mark out for delivery | yes | same transition path as seller callable |
| `LIVRER <id>` | mark delivered | yes | requires valid confirmation and same rules |
| `ANNULER <id>` | cancel order | yes | buyer-only or seller-only depending on ownership |
| `STATUT <id>` | status lookup | no | returns current order status |
| `STOP` | opt out | no | respects consent and suppresses future WhatsApp sends |
| free-form text | no action | no | never mutates state |

### Role matrix

| Role | Own notifications | Read own notifications | Manage preferences | Link WhatsApp | Trigger WhatsApp commands |
| --- | --- | --- | --- | --- | --- |
| user | yes | yes | yes | yes | yes when linked and authorized |
| admin | yes | yes | yes | yes | limited to owned or managed order scopes |
| superadmin | yes | yes | yes | yes | same as admin + broader alerting |

### Cost and limits notes

- User/channel caps are enforced in `notificationLimits.userChannelHourly` and
  `userChannelDaily` with a shared global WhatsApp daily budget guard.
- Rate limits for callable actions and inbound commands are enforced with the
  shared Firebase Firestore-backed limiter.
- The WhatsApp adapter sends only server-rendered registry messages to the
  configured `/send` endpoint, using a Google OIDC identity token. Emulator
  execution never contacts the live service; tests use a local Bearer-auth
  mock server.
- No App Check is enabled on notifications functions.
- Sensitive content such as pickup codes, full addresses, and full phone
  numbers is not embedded in push payloads or lock-screen text.

### WhatsApp integration configuration and remaining work

- Outbound endpoint: `https://us-central1-glass-arcanum-480721-n7.cloudfunctions.net/whatsapp/send`.
- Outbound authentication: Google OIDC identity token with audience
  `https://us-central1-glass-arcanum-480721-n7.cloudfunctions.net/whatsapp`.
- Request mapping: `POST` JSON `{ "to": "<E.164 phone>", "text": "<server-rendered message>" }`.
- Response mapping: requires `success: true` and `data.msgId`; the adapter
  returns that message ID.
- The caller runtime service account
  `store-notifications@next-3d-scene.iam.gserviceaccount.com` must be granted
  `roles/cloudfunctions.invoker` on the WhatsApp function in project
  `glass-arcanum-480721-n7`.
- The request contract carries rendered text rather than provider template IDs.
  Confirm the WhatsApp service itself enforces the approved-template policy and
  the 24-hour session window before enabling production sends; its current
  contract does not expose a template identifier.
- Inbound auth uses the private Cloud Functions IAM/OIDC invoker gate. Grant
  `roles/run.invoker` to the WhatsApp service identity before connecting it;
  the handler rejects unauthenticated callers before processing requests.
- Replace the current French/Arabic/English registry copy and event names with
  the actual WhatsApp-approved templates before production use.

This module is intentionally structured so channel ordering and template names
are data-driven: adding or reordering channels requires no engine changes.

### Single notifications API

Client notification operations are exposed through one authenticated HTTP
function, `notificationService`, instead of separate callable endpoints. The
base URL is:

```text
https://us-central1-next-3d-scene.cloudfunctions.net/notificationService
```

Send JSON `POST` requests with `Authorization: Bearer <Firebase ID token>` to
these routes:

| Route | Operation |
| --- | --- |
| `/notifications/device/register` | Register an FCM device token |
| `/notifications/device/unregister` | Remove an FCM device token |
| `/notifications/list` | Get the caller's notifications |
| `/notifications/read` | Mark one caller-owned notification as read |
| `/notifications/read-all` | Mark all caller-owned notifications as read |
| `/notifications/preferences` | Update the caller's preferences |
| `/notifications/whatsapp/link` | Start WhatsApp number verification |
| `/notifications/whatsapp/confirm-link` | Confirm WhatsApp number verification |
| `/notifications/whatsapp/unlink` | Unlink the caller's WhatsApp number |

The legacy individual callable exports are removed. Firestore event triggers
and scheduled notification jobs remain separate deployed functions because
they must be invoked by Firestore and Cloud Scheduler rather than by HTTP.
