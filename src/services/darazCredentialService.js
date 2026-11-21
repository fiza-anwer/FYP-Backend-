import { decryptStoredCredentials, encryptCredentialTree } from "../db/credentialEncryption.js";

export async function persistDarazCredentialsIfChanged(
  companyIntegrationsColl,
  companyIntegration,
  credentials
) {
  if (!companyIntegration?._id || !credentials?.access_token) return false;

  const previousCredentials = decryptStoredCredentials(companyIntegration.credentials || {});
  const refreshedFields = [
    "access_token",
    "refresh_token",
    "authorization_code",
    "expires_in",
    "refresh_expires_in",
  ];
  if (refreshedFields.every((field) => credentials[field] === previousCredentials?.[field])) {
    return false;
  }

  const encryptedCredentials = encryptCredentialTree(credentials);
  const result = await companyIntegrationsColl.updateOne(
    { _id: companyIntegration._id },
    { $set: { credentials: encryptedCredentials, updated_at: new Date() } }
  );
  if (result.matchedCount === 0) {
    throw new Error("Daraz credentials could not be saved because the integration no longer exists.");
  }

  companyIntegration.credentials = encryptedCredentials;
  return true;
}

export async function withPersistedDarazCredentials(
  companyIntegrationsColl,
  companyIntegration,
  credentials,
  operation
) {
  let value;
  let operationError;
  let operationFailed = false;
  try {
    value = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await persistDarazCredentialsIfChanged(
      companyIntegrationsColl,
      companyIntegration,
      credentials
    );
  } catch (persistError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, persistError],
        "Daraz operation failed and updated credentials could not be saved."
      );
    }
    throw persistError;
  }

  if (operationFailed) throw operationError;
  return value;
}
