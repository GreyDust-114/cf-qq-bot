import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";

const PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export function getKeyPair(appSecret) {
  if (!appSecret) {
    throw new Error("QQ_APP_SECRET is missing");
  }

  let seedText = appSecret;

  while (seedText.length < 32) {
    seedText += seedText;
  }

  const seed = Buffer.from(seedText.slice(0, 32), "utf8");

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });

  return {
    privateKey,
    publicKey: crypto.createPublicKey(privateKey),
  };
}

export function signValidationResponse(appSecret, eventTs, plainToken) {
  const { privateKey } = getKeyPair(appSecret);
  const message = Buffer.from(eventTs + plainToken, "utf8");

  return crypto.sign(null, message, privateKey).toString("hex");
}

export function verifyWebhookSignature(
  appSecret,
  timestamp,
  signature,
  rawBody,
) {
  try {
    const { publicKey } = getKeyPair(appSecret);

    const message = Buffer.concat([
      Buffer.from(timestamp, "utf8"),
      rawBody,
    ]);

    return crypto.verify(
      null,
      message,
      publicKey,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}
