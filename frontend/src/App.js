// src/App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { InteractionRequiredAuthError, InteractionStatus } from "@azure/msal-browser";
import { foundryLoginRequest } from "./authConfig";
import { runtimeEnv } from "./runtimeEnv";

/** 后端地址和默认 Agent 名称，统一从运行时环境配置读取 */
const BACKEND_BASE = runtimeEnv.backendBase;
const DEFAULT_AGENT_NAME = runtimeEnv.agentName;

/** 对敏感值进行脱敏处理，只显示前4位和后4位 */
function maskValue(val) {
  if (!val || typeof val !== "string") return val;
  if (val.length <= 10) return val;
  return val.slice(0, 4) + "****" + val.slice(-4);
}

/** 展示 key-value 行的通用组件，masked=true 时对值进行脱敏 */
function Row({ label, value, masked = false }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        gap: 12,
        padding: "8px 0",
        borderTop: "1px solid #f1f5f9",
      }}
    >
      <div style={{ color: "#475569", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{masked ? maskValue(value) : (value ?? "—")}</div>
    </div>
  );
}

/** 将文本中的 markdown 链接转为可点击的 <a> 标签 */
function renderMarkdown(text) {
  const parts = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let lastIndex = 0;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={match.index}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "#2563eb", textDecoration: "underline" }}
      >
        {match[1]}
      </a>
    );
    lastIndex = linkRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

/** 聊天消息气泡组件，区分用户和助手样式 */
function Bubble({ role, text }) {
  const isUser = role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "8px 0",
      }}
    >
      <div
        style={{
          maxWidth: "78%",
          padding: "10px 14px",
          borderRadius: 14,
          background: isUser
            ? "linear-gradient(135deg, #2563eb, #7c3aed)"
            : "white",
          color: isUser ? "white" : "#1e293b",
          border: isUser ? "none" : "1px solid #e2e8f0",
          boxShadow: isUser
            ? "0 2px 8px rgba(37, 99, 235, 0.2)"
            : "0 1px 4px rgba(0, 0, 0, 0.04)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.5,
          fontSize: 13,
        }}
      >
        {isUser ? text : renderMarkdown(text)}
      </div>
    </div>
  );
}

/** 主应用组件：MSAL 登录 + Foundry Agent 聊天 + MCP 审批 + OAuth 同意 */
export default function App() {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const account = useMemo(
    () => instance.getActiveAccount() ?? accounts?.[0] ?? null,
    [instance, accounts]
  );

  const [error, setError] = useState(null);
  const [needsConsent, setNeedsConsent] = useState(false);

  /** 固定使用 Foundry scope（已移除 Fabric scope 切换） */
  const currentScopeRequest = foundryLoginRequest;

  const [accessToken, setAccessToken] = useState(null);

  // 聊天状态
  const [agentName] = useState(DEFAULT_AGENT_NAME);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const [previousResponseId, setPreviousResponseId] = useState(null);

  // MCP 工具审批
  const [pendingApprovals, setPendingApprovals] = useState(null);
  const [approvalDecisions, setApprovalDecisions] = useState({});
  const [pendingResponseIdForApproval, setPendingResponseIdForApproval] = useState(null);

  // OAuth 同意（Foundry oauth_consent_request）
  const [oauthConsentLink, setOauthConsentLink] = useState(null);
  const [pendingResponseIdForOauth, setPendingResponseIdForOauth] = useState(null);

  const chatScrollContainerRef = useRef(null);

  /** 将聊天面板内部滚动到底部，避免触发整个页面滚动 */
  const scrollChatToBottom = () => {
    requestAnimationFrame(() => {
      const chatScrollContainer = chatScrollContainerRef.current;
      if (!chatScrollContainer) return;

      chatScrollContainer.scrollTo({
        top: chatScrollContainer.scrollHeight,
        behavior: "smooth",
      });
    });
  };

  useEffect(() => {
    scrollChatToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pendingApprovals, oauthConsentLink, chatLoading]);

  /** 发起 MSAL 重定向登录 */
  const login = async () => {
    setError(null);
    setNeedsConsent(false);
    await instance.loginRedirect(currentScopeRequest);
  };

  /** 登出并清理所有状态 */
  const logout = async () => {
    setError(null);
    setNeedsConsent(false);
    setAccessToken(null);

    setMessages([]);
    setPreviousResponseId(null);
    setPendingApprovals(null);
    setApprovalDecisions({});
    setPendingResponseIdForApproval(null);
    setOauthConsentLink(null);
    setPendingResponseIdForOauth(null);

    await instance.logoutRedirect({ account });
  };

  /** 静默获取 access token，失败时提示需要 consent */
  const tryGetTokenSilent = async () => {
    if (!account) return null;

    setError(null);
    try {
      const res = await instance.acquireTokenSilent({
        ...currentScopeRequest,
        account,
      });

      setAccessToken(res.accessToken);
      setNeedsConsent(false);

      return res.accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) {
        setNeedsConsent(true);
        return null;
      }
      setError(e?.message || String(e));
      return null;
    }
  };

  /** 触发交互式 consent 获取 token */
  const consentAndGetToken = async () => {
    if (!account) return;
    setError(null);
    setNeedsConsent(false);
    await instance.acquireTokenRedirect({ ...currentScopeRequest, account });
  };

  /** 重置聊天状态 */
  const resetChat = () => {
    setMessages([]);
    setPreviousResponseId(null);
    setPendingApprovals(null);
    setApprovalDecisions({});
    setPendingResponseIdForApproval(null);
    setOauthConsentLink(null);
    setPendingResponseIdForOauth(null);
    setError(null);
  };

  /** 发送 POST /chat 请求到后端 */
  const postChat = async (body) => {
    let token = accessToken;
    if (!token) token = await tryGetTokenSilent();
    if (!token) return { ok: false, error: "No access token (consent required?)" };

    const res = await fetch(`${BACKEND_BASE}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.detail || data?.error || `HTTP ${res.status}`, data };
    return { ok: true, data };
  };

  /** 处理后端聊天响应：区分 OAuth 同意、MCP 审批、正常输出 */
  const applyChatResponse = (data) => {
    // OAuth 同意请求（Foundry oauth_consent_request）
    if (data.status === "oauth_consent_required") {
      setOauthConsentLink(data.consent_link || null);
      setPendingResponseIdForOauth(data.response_id || null);
      setPreviousResponseId(data.response_id || null);

      const hasResponseId = !!data.response_id;
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: hasResponseId
            ? "OAuth consent required to access the MCP tools. Open the consent link below, complete sign-in, then click \u201cI completed sign-in\u201d."
            : "MCP tool authentication expired. Open the consent link below to re-authenticate, then resend your question.",
        },
      ]);
      return;
    }

    // MCP 工具审批请求
    if (data.status === "approval_required") {
      setPendingApprovals(data.approval_requests || []);
      setPendingResponseIdForApproval(data.response_id || null);
      setPreviousResponseId(data.response_id || null);

      const defaults = {};
      for (const r of data.approval_requests || []) defaults[r.id] = false;
      setApprovalDecisions(defaults);
      return;
    }

    // 正常输出
    const out = data.output_text || "";
    setMessages((m) => [...m, { role: "assistant", text: out || "(no output_text)" }]);
    setPreviousResponseId(data.response_id || null);

    setPendingApprovals(null);
    setPendingResponseIdForApproval(null);
    setApprovalDecisions({});
    setOauthConsentLink(null);
    setPendingResponseIdForOauth(null);
  };

  /** 发送用户消息 */
  const sendMessage = async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;

    setError(null);
    setChatInput("");
    setChatLoading(true);

    setMessages((m) => [...m, { role: "user", text }]);

    try {
      const { ok, data, error: err } = await postChat({
        agent_name: agentName,
        message: text,
        previous_response_id: previousResponseId,
      });

      if (!ok) throw new Error(err || "Chat request failed");
      applyChatResponse(data);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setChatLoading(false);
    }
  };

  /** 用户完成 OAuth 同意后继续 Foundry 响应链 */
  const resumeAfterOauthConsent = async () => {
    if (chatLoading) return;

    setError(null);
    setChatLoading(true);
    setOauthConsentLink(null);

    try {
      let result;

      if (pendingResponseIdForOauth) {
        result = await postChat({
          agent_name: agentName,
          previous_response_id: pendingResponseIdForOauth,
          action: "continue",
        });
      } else {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (!lastUserMsg?.text) {
          setError("No previous message to resend. Please type your question again.");
          setChatLoading(false);
          return;
        }
        result = await postChat({
          agent_name: agentName,
          message: lastUserMsg.text,
        });
      }

      const { ok, data, error: err } = result;
      if (!ok) throw new Error(err || "Continue after OAuth consent failed");
      applyChatResponse(data);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setChatLoading(false);
      setPendingResponseIdForOauth(null);
    }
  };

  /** 提交 MCP 工具审批决定 */
  const submitApprovals = async () => {
    if (!pendingApprovals?.length || !pendingResponseIdForApproval || chatLoading) return;

    setError(null);
    setChatLoading(true);

    try {
      const approvals = pendingApprovals.map((r) => ({
        approval_request_id: r.id,
        approve: !!approvalDecisions[r.id],
      }));

      const { ok, data, error: err } = await postChat({
        agent_name: agentName,
        previous_response_id: pendingResponseIdForApproval,
        approvals,
      });

      if (!ok) throw new Error(err || "Approval submit failed");
      applyChatResponse(data);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setChatLoading(false);
    }
  };

  /** 认证完成后静默获取 token */
  useEffect(() => {
    if (!isAuthenticated || !account) return;
    if (inProgress !== InteractionStatus.None) return;
    tryGetTokenSilent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, account, inProgress]);

  const idClaims = account?.idTokenClaims;

  return (
    <div
      style={{
        padding: "2rem",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
        background: "#f6f7fb",
        minHeight: "100vh",
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        {!isAuthenticated && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "70vh",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: 20,
                background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 24,
                boxShadow: "0 8px 24px rgba(37, 99, 235, 0.25)",
              }}
            >
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>

            <h1 style={{ margin: "0 0 8px 0", fontSize: 28, fontWeight: 700, color: "#0f172a" }}>
              Foundry Agent Demo
            </h1>
            <p style={{ margin: "0 0 32px 0", fontSize: 15, color: "#64748b", maxWidth: 600, lineHeight: 1.6 }}>
              Chat with your AI agent to search Jira issues, browse Confluence pages, and more — powered by Microsoft Foundry Agent Service with OAuth identity passthrough.
            </p>

            <button
              onClick={login}
              style={{
                padding: "12px 32px",
                fontSize: 15,
                fontWeight: 600,
                background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                color: "white",
                border: "none",
                borderRadius: 14,
                cursor: "pointer",
                boxShadow: "0 4px 14px rgba(37, 99, 235, 0.3)",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-1px)";
                e.currentTarget.style.boxShadow = "0 6px 20px rgba(37, 99, 235, 0.4)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "0 4px 14px rgba(37, 99, 235, 0.3)";
              }}
            >
              Sign in with Microsoft
            </button>

            {error && (
              <div
                style={{
                  marginTop: 20,
                  background: "#fff1f2",
                  border: "1px solid #fecdd3",
                  color: "#9f1239",
                  padding: "10px 16px",
                  borderRadius: 12,
                  fontSize: 13,
                  maxWidth: 420,
                }}
              >
                {error}
              </div>
            )}
          </div>
        )}

        {isAuthenticated && account && (
          <div style={{ display: "grid", gap: 16, marginTop: 8 }}>
            {error && (
              <div
                style={{
                  background: "#fff1f2",
                  border: "1px solid #fecdd3",
                  color: "#9f1239",
                  padding: "10px 14px",
                  borderRadius: 14,
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            )}

            {/* 顶部栏：用户信息 + 操作按钮 */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0 2px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 2px 8px rgba(37, 99, 235, 0.2)",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>Foundry Agent Demo</div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>{account.name}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value && !chatLoading && !needsConsent && !oauthConsentLink) {
                      const question = e.target.value;
                      e.target.value = "";
                      setChatInput("");
                      setError(null);
                      setChatLoading(true);
                      setMessages((m) => [...m, { role: "user", text: question }]);
                      postChat({
                        agent_name: agentName,
                        message: question,
                        previous_response_id: previousResponseId,
                      }).then(({ ok, data, error: err }) => {
                        if (!ok) {
                          setError(err || "Chat request failed");
                        } else {
                          applyChatResponse(data);
                        }
                      }).catch((err) => {
                        setError(err?.message || String(err));
                      }).finally(() => {
                        setChatLoading(false);
                      });
                    }
                  }}
                  disabled={chatLoading || needsConsent || !!oauthConsentLink}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: 14,
                    padding: "8px 12px",
                    fontSize: 13,
                    background: "white",
                    color: "#475569",
                    minWidth: 160,
                  }}
                >
                  <option value="">Quick question...</option>
                  <option value='请使用 confluence_search 工具搜索 Confluence 中与 "MCP-PERM-TEST-20260409" 相关的页面，只返回页面标题列表。'>搜索 MCP-PERM-TEST-20260409</option>
                  <option value='请使用 confluence_search 工具搜索 Confluence 中与 "MCP-PERM-TEST-20260409 USERA-ONLY" 相关的页面，只返回页面标题列表。'>搜索 USERA-ONLY</option>
                  <option value='请使用 confluence_search 工具搜索 Confluence 中与 "MCP-PERM-TEST-20260409 USERB-ONLY" 相关的页面，只返回页面标题列表。'>搜索 USERB-ONLY</option>
                </select>
                <button onClick={resetChat} disabled={chatLoading}>New chat</button>
                <button onClick={logout}>Sign out</button>
              </div>
            </div>

            {/* 聊天卡片 */}
            <div
              style={{
                background: "white",
                borderRadius: 18,
                boxShadow: "0 2px 12px rgba(0, 0, 0, 0.06)",
                border: "1px solid #e8ecf2",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* 消息区域 */}
              <div
                ref={chatScrollContainerRef}
                style={{
                  background: "#f8fafc",
                  padding: "16px 16px 8px",
                  minHeight: 380,
                  maxHeight: 480,
                  overflowY: "auto",
                }}
              >
                {messages.length === 0 ? (
                  <div style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 340,
                    color: "#94a3b8",
                    fontSize: 14,
                    gap: 12,
                  }}>
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>Send a message or pick a quick question to get started.</span>
                  </div>
                ) : (
                  messages.map((m, idx) => <Bubble key={idx} role={m.role} text={m.text} />)
                )}

                {chatLoading && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, marginLeft: 4 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                      animation: "pulse 1.2s infinite",
                    }} />
                    <span style={{ color: "#94a3b8", fontSize: 13 }}>Thinking...</span>
                  </div>
                )}
              </div>

              {/* OAuth 同意流程 */}
              {oauthConsentLink && (
                <div
                  style={{
                    margin: "0 16px 12px",
                    background: "linear-gradient(135deg, #ecfeff, #f0f9ff)",
                    border: "1px solid #bae6fd",
                    borderRadius: 14,
                    padding: 14,
                  }}
                >
                  <div style={{ fontWeight: 700, color: "#0369a1", marginBottom: 6, fontSize: 14 }}>
                    Sign in required (OAuth consent)
                  </div>
                  <div style={{ color: "#0c4a6e", fontSize: 13, marginBottom: 12 }}>
                    Open the consent link in a new tab and complete sign-in. Then come back and click "I completed sign-in".
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <a
                      href={oauthConsentLink}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "10px 16px",
                        borderRadius: 14,
                        background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                        color: "white",
                        textDecoration: "none",
                        fontSize: 13,
                        fontWeight: 600,
                        boxShadow: "0 2px 8px rgba(37, 99, 235, 0.25)",
                      }}
                    >
                      Open consent link
                    </a>

                    <button onClick={resumeAfterOauthConsent} disabled={chatLoading}>
                      I completed sign-in
                    </button>
                  </div>

                  {pendingResponseIdForOauth && (
                    <div style={{ marginTop: 10, fontSize: 12, color: "#0369a1" }}>
                      (Debug) pending_response_id: <code>{pendingResponseIdForOauth}</code>
                    </div>
                  )}
                </div>
              )}

              {/* MCP 工具审批 */}
              {pendingApprovals?.length > 0 && (
                <div
                  style={{
                    margin: "0 16px 12px",
                    background: "linear-gradient(135deg, #fff7ed, #fffbeb)",
                    border: "1px solid #fed7aa",
                    borderRadius: 14,
                    padding: 14,
                  }}
                >
                  <div style={{ fontWeight: 600, color: "#9a3412", marginBottom: 6, fontSize: 14 }}>
                    MCP approval required
                  </div>
                  <div style={{ color: "#9a3412", fontSize: 13, marginBottom: 10 }}>
                    Review each tool call and approve/deny. Then click "Submit approvals".
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    {pendingApprovals.map((r) => (
                      <div
                        key={r.id}
                        style={{
                          background: "white",
                          border: "1px solid #fed7aa",
                          borderRadius: 14,
                          padding: 12,
                        }}
                      >
                        <Row label="Server" value={r.server_label} />
                        <Row label="Tool" value={r.tool_name} />
                        <Row label="Request ID" value={r.id} />

                        <div style={{ marginTop: 8, fontSize: 13, color: "#334155" }}>
                          Arguments:
                          <pre
                            style={{
                              marginTop: 6,
                              marginBottom: 0,
                              padding: 10,
                              background: "#f8fafc",
                              color: "#1e293b",
                              border: "1px solid #e2e8f0",
                              borderRadius: 10,
                              overflowX: "auto",
                              fontSize: 12,
                              lineHeight: 1.4,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {JSON.stringify(r.arguments ?? {}, null, 2)}
                          </pre>
                        </div>

                        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                            <input
                              type="checkbox"
                              checked={!!approvalDecisions[r.id]}
                              onChange={(e) =>
                                setApprovalDecisions((prev) => ({
                                  ...prev,
                                  [r.id]: e.target.checked,
                                }))
                              }
                            />
                            Approve
                          </label>
                          {!approvalDecisions[r.id] && (
                            <span style={{ color: "#64748b", fontSize: 13 }}>Denied by default</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                    <button onClick={submitApprovals} disabled={chatLoading}>
                      Submit approvals
                    </button>
                    <button
                      onClick={() => {
                        const denied = {};
                        for (const r of pendingApprovals) denied[r.id] = false;
                        setApprovalDecisions(denied);
                      }}
                      disabled={chatLoading}
                    >
                      Deny all
                    </button>
                  </div>
                </div>
              )}

              {oauthConsentLink && (
                <div style={{ padding: "0 16px 8px", color: "#0369a1", fontSize: 13 }}>
                  Complete OAuth consent above to enable MCP tools, then continue.
                </div>
              )}

              {needsConsent && (
                <div style={{ padding: "0 16px 8px", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ color: "#b45309", fontSize: 13 }}>
                    Consent required to get access token.
                  </span>
                  <button onClick={consentAndGetToken} style={{ fontSize: 13 }}>
                    Continue to consent
                  </button>
                </div>
              )}

              {/* 输入框 */}
              <div style={{ display: "flex", gap: 10, padding: "12px 16px", borderTop: "1px solid #f1f5f9" }}>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="Type a message..."
                  disabled={chatLoading || needsConsent || !!oauthConsentLink}
                  style={{
                    flex: 1,
                    border: "1px solid #e2e8f0",
                    borderRadius: 14,
                    padding: "10px 14px",
                    fontSize: 13,
                    outline: "none",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={(e) => { e.target.style.borderColor = "#93c5fd"; }}
                  onBlur={(e) => { e.target.style.borderColor = "#e2e8f0"; }}
                />
                <button
                  onClick={sendMessage}
                  disabled={chatLoading || needsConsent || !!oauthConsentLink || !chatInput.trim()}
                  style={{
                    background: chatInput.trim() ? "linear-gradient(135deg, #2563eb, #7c3aed)" : undefined,
                    color: chatInput.trim() ? "white" : undefined,
                    border: chatInput.trim() ? "none" : undefined,
                    boxShadow: chatInput.trim() ? "0 2px 8px rgba(37, 99, 235, 0.25)" : undefined,
                  }}
                >
                  Send
                </button>
              </div>
            </div>

            {/* 用户信息面板 */}
            <div
              style={{
                background: "white",
                borderRadius: 18,
                boxShadow: "0 2px 12px rgba(0, 0, 0, 0.06)",
                border: "1px solid #e8ecf2",
                padding: 16,
              }}
            >
              <h2 style={{ marginTop: 0, fontSize: 15, fontWeight: 600, color: "#0f172a" }}>User (from ID token)</h2>
              <Row label="Name" value={account.name} />
              <Row label="Username" value={account.username} masked />
              <Row label="Tenant (tid)" value={idClaims?.tid} masked />
              <Row label="Object ID (oid)" value={idClaims?.oid} masked />
              <Row label="preferred_username" value={idClaims?.preferred_username} masked />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
