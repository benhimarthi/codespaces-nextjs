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

provider "google" {
  project = var.project_id
}

locals {
  function_service_accounts = toset([
    "auth-register-user",
    "auth-set-user-role",
    "auth-get-my-profile",
    "auth-delete-my-account",
  ])

  auth_roles = {
    profile_access = {
      role_id = "functionAuthProfileAccess"
      title   = "Function Auth Profile Access"
      permissions = [
        "firebaseauth.users.get",
        "firebaseauth.users.update",
      ]
    }
    account_deletion = {
      role_id    = "functionAuthAccountDeletion"
      title      = "Function Auth Account Deletion"
      permissions = ["firebaseauth.users.delete"]
    }
  }

  function_auth_roles = {
    "auth-register-user"    = "profile_access"
    "auth-set-user-role"    = "profile_access"
    "auth-delete-my-account" = "account_deletion"
  }

  firestore_roles = {
    profile_and_limits = {
      role_id = "functionFirestoreProfileAndLimits"
      title   = "Function Firestore Profile and Rate Limits"
      permissions = [
        "datastore.databases.get",
        "datastore.entities.create",
        "datastore.entities.get",
        "datastore.entities.update",
      ]
    }
    recursive_delete = {
      role_id = "functionFirestoreRecursiveDelete"
      title   = "Function Firestore Recursive Delete"
      permissions = [
        "datastore.databases.get",
        "datastore.entities.delete",
        "datastore.entities.get",
        "datastore.entities.list",
        "datastore.entities.update",
        "datastore.entities.create",
      ]
    }
  }

  function_firestore_roles = {
    "auth-register-user"     = "profile_and_limits"
    "auth-set-user-role"     = "profile_and_limits"
    "auth-get-my-profile"   = "profile_and_limits"
    "auth-delete-my-account" = "recursive_delete"
  }
}

resource "google_service_account" "function" {
  for_each     = local.function_service_accounts
  project      = var.project_id
  account_id   = each.value
  display_name = "Cloud Function ${each.value}"
}

resource "google_project_iam_custom_role" "function_auth" {
  for_each    = local.auth_roles
  project     = var.project_id
  role_id     = each.value.role_id
  title       = each.value.title
  description = "Minimum Firebase Authentication permissions for this function group."
  permissions = each.value.permissions
}

resource "google_project_iam_custom_role" "function_firestore" {
  for_each    = local.firestore_roles
  project     = var.project_id
  role_id     = each.value.role_id
  title       = each.value.title
  description = "Minimum Firestore permissions for this function group."
  permissions = each.value.permissions
}

resource "google_project_iam_member" "function_firestore" {
  for_each = local.function_firestore_roles
  project  = var.project_id
  role     = google_project_iam_custom_role.function_firestore[each.value].name
  member   = "serviceAccount:${google_service_account.function[each.key].email}"
}

resource "google_project_iam_member" "function_auth" {
  for_each = local.function_auth_roles
  project  = var.project_id
  role     = google_project_iam_custom_role.function_auth[each.value].name
  member   = "serviceAccount:${google_service_account.function[each.key].email}"
}
