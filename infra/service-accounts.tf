terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

variable "project_id" {
  description = "Firebase/Google Cloud project ID."
  type        = string
}

variable "whatsapp_service_account_email" {
  description = "Existing WhatsApp service identity allowed to invoke the private inbound handler. Leave empty until configured."
  type        = string
  default     = ""
}

provider "google" {
  project = var.project_id
}

locals {
  auth_service_account = "auth-service"
  product_service_account = "product-service"

  auth_permissions = [
    "firebaseauth.users.create",
    "firebaseauth.users.delete",
    "firebaseauth.users.get",
    "firebaseauth.users.update",
  ]

  firestore_permissions = [
    "datastore.databases.get",
    "datastore.entities.create",
    "datastore.entities.delete",
    "datastore.entities.get",
    "datastore.entities.list",
    "datastore.entities.update",
  ]

  product_firestore_permissions = [
    "datastore.databases.get",
    "datastore.entities.create",
    "datastore.entities.delete",
    "datastore.entities.get",
    "datastore.entities.list",
    "datastore.entities.update",
  ]

  product_auth_permissions = [
    "firebaseauth.users.get",
  ]

  storage_read_permissions = [
    "storage.objects.get",
  ]

  store_service_groups = toset([
    "cart",
    "orders",
    "seller-orders",
    "admin-orders",
    "order-scheduler",
    "notifications",
  ])

  store_callable_groups = toset([
    "cart",
    "orders",
    "seller-orders",
    "admin-orders",
    "notifications",
  ])
}

resource "google_service_account" "auth_service" {
  project      = var.project_id
  account_id   = local.auth_service_account
  display_name = "Cloud Function auth-service"
}

resource "google_project_iam_custom_role" "auth_service_auth" {
  project     = var.project_id
  role_id     = "functionAuthServiceAuthAccess"
  title       = "Function Auth Service Auth Access"
  description = "Minimum Firebase Authentication permissions for the auth service."
  permissions = local.auth_permissions
}

resource "google_project_iam_custom_role" "auth_service_firestore" {
  project     = var.project_id
  role_id     = "functionAuthServiceFirestoreAccess"
  title       = "Function Auth Service Firestore Access"
  description = "Minimum Firestore permissions for profiles, rate limits, and account cleanup."
  permissions = local.firestore_permissions
}

resource "google_project_iam_member" "auth_service_firestore" {
  project = var.project_id
  role    = google_project_iam_custom_role.auth_service_firestore.name
  member  = "serviceAccount:${google_service_account.auth_service.email}"
}

resource "google_project_iam_member" "auth_service_auth" {
  project = var.project_id
  role    = google_project_iam_custom_role.auth_service_auth.name
  member  = "serviceAccount:${google_service_account.auth_service.email}"
}

resource "google_service_account" "product_service" {
  project      = var.project_id
  account_id   = local.product_service_account
  display_name = "Cloud Function product service"
}

resource "google_project_iam_custom_role" "product_firestore" {
  project     = var.project_id
  role_id     = "functionProductFirestoreAccess"
  title       = "Function Product Firestore Access"
  description = "Firestore access for product data, reservations, rate limits, and audit logs."
  permissions = local.product_firestore_permissions
}

resource "google_project_iam_custom_role" "product_seller_auth" {
  project     = var.project_id
  role_id     = "functionProductSellerAuthRead"
  title       = "Function Product Seller Auth Read"
  description = "Read Auth account status for seller eligibility checks."
  permissions = local.product_auth_permissions
}

resource "google_project_iam_custom_role" "product_storage_read" {
  project     = var.project_id
  role_id     = "functionProductStorageRead"
  title       = "Function Product Storage Read"
  description = "Read uploaded product image metadata for server-side verification."
  permissions = local.storage_read_permissions
}

resource "google_project_iam_member" "product_firestore" {
  project = var.project_id
  role    = google_project_iam_custom_role.product_firestore.name
  member  = "serviceAccount:${google_service_account.product_service.email}"
}

resource "google_project_iam_member" "product_seller_auth" {
  project = var.project_id
  role    = google_project_iam_custom_role.product_seller_auth.name
  member  = "serviceAccount:${google_service_account.product_service.email}"
}

resource "google_project_iam_member" "product_storage_read" {
  project = var.project_id
  role    = google_project_iam_custom_role.product_storage_read.name
  member  = "serviceAccount:${google_service_account.product_service.email}"
}

resource "google_service_account" "store_service" {
  for_each     = local.store_service_groups
  project      = var.project_id
  account_id   = "store-${each.key}"
  display_name = "Cloud Function store ${each.key}"
}

resource "google_project_iam_custom_role" "store_firestore" {
  project     = var.project_id
  role_id     = "functionStoreFirestoreAccess"
  title       = "Function Store Firestore Access"
  description = "Firestore access for cart, orders, rate limits, and append-only audit records."
  permissions = local.firestore_permissions
}

resource "google_project_iam_member" "store_firestore" {
  for_each = local.store_service_groups
  project  = var.project_id
  role     = google_project_iam_custom_role.store_firestore.name
  member   = "serviceAccount:${google_service_account.store_service[each.key].email}"
}

resource "google_project_iam_custom_role" "store_auth_read" {
  project     = var.project_id
  role_id     = "functionStoreAuthRead"
  title       = "Function Store Auth Read"
  description = "Read Auth account disabled, verification, and creation metadata for store operations."
  permissions = local.product_auth_permissions
}

resource "google_project_iam_member" "store_auth_read" {
  for_each = local.store_callable_groups
  project  = var.project_id
  role     = google_project_iam_custom_role.store_auth_read.name
  member   = "serviceAccount:${google_service_account.store_service[each.key].email}"
}

resource "google_project_iam_custom_role" "notification_runtime" {
  project     = var.project_id
  role_id     = "functionNotificationsRuntime"
  title       = "Function Notifications Runtime"
  description = "Firebase Auth read, FCM send, Firestore access, and Eventarc event receipt for notification functions."
  permissions = concat(
    local.firestore_permissions,
    local.product_auth_permissions,
    [
      "cloudmessaging.messages.create",
      "eventarc.events.receiveEvent",
    ],
  )
}

resource "google_project_iam_member" "notification_runtime" {
  project = var.project_id
  role    = google_project_iam_custom_role.notification_runtime.name
  member  = "serviceAccount:${google_service_account.store_service["notifications"].email}"
}

resource "google_cloudfunctions2_function_iam_member" "whatsapp_inbound_invoker" {
  count         = var.whatsapp_service_account_email == "" ? 0 : 1
  project       = var.project_id
  location      = "us-central1"
  cloud_function = "whatsappInboundHandler"
  role          = "roles/cloudfunctions.invoker"
  member        = "serviceAccount:${var.whatsapp_service_account_email}"
}
