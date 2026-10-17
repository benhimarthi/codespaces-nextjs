export const EmailAdapter = Object.freeze({
  name: "email",
  supports: () => true,
  async send() {
    return { ok: false, errorCode: "EMAIL_PROVIDER_NOT_CONFIGURED" };
  },
});
