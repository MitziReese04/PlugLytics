// Creates the RSA key pair PlugLytics uses as an LTI 1.3 tool.
//
//   npm run lti:keygen
//
// Copy the printed LTI_PRIVATE_KEY line into .env locally, or into your host's
// environment variables (for example Vercel). Never commit it.
// The public half is served automatically at /lti/jwks.
const crypto = require("crypto");

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).trim();

console.log("# Add this line to .env (or your host's environment variables). Keep it secret.");
console.log(`LTI_PRIVATE_KEY="${pem.replace(/\n/g, "\\n")}"`);
