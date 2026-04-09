/** 优先使用服务端注入的运行时配置，开发模式下回退到 CRA 编译时环境变量 */
const envSource =
  (window._env_ && Object.keys(window._env_).length > 0 ? window._env_ : process.env) || {};

const currentOrigin = window.location.origin;

export const runtimeEnv = {
  msalClientId: envSource.REACT_APP_MSAL_CLIENT_ID || "",
  msalTenantId: envSource.REACT_APP_MSAL_TENANT_ID || "",
  redirectUri: envSource.REACT_APP_REDIRECT_URI || currentOrigin,
  backendBase: (envSource.REACT_APP_BACKEND_URL || currentOrigin || "http://localhost:8765").replace(/\/$/, ""),
  agentName: envSource.REACT_APP_AGENT_NAME || "FoundryAtlassianAgent",
};
