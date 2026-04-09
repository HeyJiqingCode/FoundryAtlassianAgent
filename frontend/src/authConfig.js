import { runtimeEnv } from "./runtimeEnv";

export const msalConfig = {
  auth: {
    clientId: runtimeEnv.msalClientId,
    authority: `https://login.microsoftonline.com/${runtimeEnv.msalTenantId || "common"}`,
    redirectUri: runtimeEnv.redirectUri,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

/** Foundry Agent Service 需要的 scope */
export const foundryLoginRequest = {
  scopes: ["https://ai.azure.com/.default"],
};
