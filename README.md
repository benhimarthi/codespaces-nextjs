# Codespaces Next.js authentication service

This repository includes Firebase Cloud Functions v2 authentication callables in
`functions/src/`, plus Firestore and Storage rules. The Functions package is
JavaScript (Node.js 22); Firebase Admin SDK calls use the function's service
account identity and do not require downloaded service-account keys.

## Assumptions and configuration

- The Firebase project ID is a placeholder: `your-firebase-project-id`.
- The only initial callable origin is `http://localhost:3000`. Replace it with
  the exact trusted browser origins before using a deployed environment.
- `setUserRole` accepts a validated target email and role, not a user ID. This
  preserves the requirement that client input never supplies a UID; the target
  UID is looked up by the Admin SDK, and self-targeting is denied.
- A profile is `users/{uid}` with `displayName` and `createdAt`. Account
  deletion recursively removes that document and its subcollections. This
  service does not use Cloud Storage for user data.
- No API keys or other application secrets are needed. Firebase Admin uses
  workload identity/IAM. If an external secret is added later, declare it with
  `defineSecret` and never put its value in an environment file.

Copy `functions/.env.example` to `functions/.env` and set the project ID and
comma-separated exact origins. Update `.firebaserc` to your Firebase project.
Do not commit `functions/.env`.

## Functions

| Callable | Behavior |
| --- | --- |
| `registerUser` | Creates the caller's profile once and assigns the default `user` custom claim if no supported role claim exists. |
| `setUserRole` | Admin-only. Resolves a target by email, rejects self-targeting, and changes only the target's `role` custom claim. |
| `getMyProfile` | Returns the caller's own profile fields only. |
| `deleteMyAccount` | Recursively deletes the caller's profile subtree and deletes the caller's Auth account; retries are safe. |

All callables require authentication, enforce App Check, use strict Zod schemas,
and reject unknown input fields. Role checks use the `role` custom claim; a
missing claim is treated as the baseline `user` role. An administrator must be
bootstrapped out-of-band from a trusted environment using the Admin SDK; there
is intentionally no self-promotion endpoint.

## Web authentication

The Next.js sign-in page supports email/password account creation and sign-in,
Google sign-in, and sign-out. Configure the Firebase Web app values in a local
`.env.local` file using `.env.example` as a template. These are Firebase client
configuration values, not Admin SDK credentials. In the Firebase console,
enable Email/Password and Google under Authentication > Sign-in method, and add
the deployed site domain to Authentication > Settings > Authorized domains.

Sensitive callables are rate-limited per UID and, when available, per client IP.
Only SHA-256-derived identity keys and counters are stored in the private
`_rateLimits` collection. Enable Firestore TTL for `_rateLimits.expiresAt`:

```sh
gcloud firestore fields ttls update expiresAt \
  --collection-group=_rateLimits --enable-ttl --project=YOUR_PROJECT_ID
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
demo project ID `demo-auth-service`; it does not deploy. Tests cover
unauthenticated calls, role authorization and self-promotion, strict input
validation, idempotent registration, UID rate limiting, role assignment, and
Firestore/Storage rules. Functions run with App Check enforcement enabled; the
emulator suite is for local validation, not an App Check attestation test.

## IAM and deployment

`infra/service-accounts.tf` creates one service account per callable and custom
Firestore roles for the profile/rate-limit operations (plus list/delete only
for recursive account cleanup). Only registration/role-management accounts
get the custom Firebase Auth get/update role, and only account deletion gets
the custom Firebase Auth delete role. No Storage or Secret Manager access is
granted.

Before deploying:

1. Set a real project ID and exact production origins in `.firebaserc` and
   `functions/.env`.
2. Enable Firebase Authentication, Cloud Firestore, Cloud Functions, Cloud
   Build, Artifact Registry, and the Firebase App Check APIs as required by the
   project.
3. Provision the accounts and IAM bindings from `infra/` with a trusted
   Terraform identity. Ensure the deployment identity can act as each function
   service account.
4. Enable the Firestore TTL policy above and configure App Check for the client
   application.
5. Bootstrap the first administrator in a trusted environment; never accept
   admin claims from client input.
6. Review the security checklist below and run the emulator suite.

Deployment commands (not run as part of this implementation):

```sh
terraform -chdir=infra init
terraform -chdir=infra apply -var="project_id=YOUR_PROJECT_ID"
npm --prefix functions run build
firebase deploy --only functions,firestore:rules,storage
```

## Security checklist

- [ ] Replace the placeholder project ID and local-only CORS origin.
- [ ] Keep `functions/.env` and service-account credentials out of source
  control; prefer workload identity over downloaded keys.
- [ ] Confirm each callable's service account and IAM grants match the Terraform
  configuration, and the deployer has only required `actAs` access.
- [ ] Enable Firestore TTL for `_rateLimits.expiresAt`.
- [ ] Configure and monitor Firebase App Check enforcement for production.
- [ ] Bootstrap and audit administrators only through a trusted Admin SDK
  environment; rotate/remove claims when access changes.
- [ ] Keep Firestore and Storage rules deployed; direct client writes are denied.
- [ ] Add tests and explicit ownership checks before introducing new data
  collections or Storage paths.
