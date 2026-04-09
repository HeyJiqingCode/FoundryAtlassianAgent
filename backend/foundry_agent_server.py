"""FastAPI 后端：代理前端请求到 Azure AI Foundry Agent Service。

职责：
- 验证前端传来的 Azure AD Bearer token
- 用用户 token 创建 Foundry AIProjectClient（用户级隔离）
- 处理 Foundry Responses API 的 OAuth consent 和 MCP approval 流程
- 返回 Agent 输出给前端
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
import jwt
from jwt import PyJWKClient
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from azure.ai.projects import AIProjectClient
from azure.core.credentials import AccessToken, TokenCredential

load_dotenv()


def _read_env(name: str, default: str = "") -> str:
    """读取环境变量并去除首尾空白。

    参数：
    - name: 环境变量名称。
    - default: 环境变量缺失时使用的默认值。

    返回：
    - str：去除首尾空白后的环境变量值。
    """
    return os.getenv(name, default).strip()


def _validate_startup_env() -> None:
    """校验后端启动必需的环境变量。

    参数：
    - 无。

    返回：
    - None：校验通过时无返回；缺失配置时抛出 RuntimeError。
    """
    missing_env_names: List[str] = []

    if not TENANT_ID:
        missing_env_names.append("AZURE_TENANT_ID")
    if not FOUNDRY_PROJECT_ENDPOINT:
        missing_env_names.append("FOUNDRY_PROJECT_ENDPOINT")

    if missing_env_names:
        missing_env_text = ", ".join(missing_env_names)
        raise RuntimeError(f"Missing required environment variables: {missing_env_text}")

# ── 配置 ──────────────────────────────────────────────────────────────
TENANT_ID = _read_env("AZURE_TENANT_ID")
FOUNDRY_AUDIENCE = "https://ai.azure.com"
FOUNDRY_PROJECT_ENDPOINT = _read_env("FOUNDRY_PROJECT_ENDPOINT")

# CORS 允许的来源，支持通过环境变量配置
CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in _read_env(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3500,http://127.0.0.1:3500"
    ).split(",")
    if o.strip()
]

_validate_startup_env()

print("FOUNDRY_PROJECT_ENDPOINT:", FOUNDRY_PROJECT_ENDPOINT)
print("CORS_ALLOWED_ORIGINS:", CORS_ALLOWED_ORIGINS)

REPO_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_BUILD_DIR = REPO_ROOT / "frontend" / "build"
FRONTEND_INDEX_FILE = FRONTEND_BUILD_DIR / "index.html"

# JWT 验证
JWKS_URL = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"
jwk_client = PyJWKClient(JWKS_URL)

# ── FastAPI 应用 ──────────────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 凭据包装器 ────────────────────────────────────────────────────────
class BearerTokenCredential(TokenCredential):
    """将前端传来的 Bearer token 包装为 Azure TokenCredential，供 AIProjectClient 使用"""

    def __init__(self, token: str, expires_on: int) -> None:
        self._token = token
        self._expires_on = expires_on

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        """返回 AccessToken，由 AIProjectClient 调用"""
        return AccessToken(self._token, self._expires_on)


# ── Token 验证 ─────────────────────────────────────────────────────────
def decode_and_validate_bearer(auth_header: Optional[str]) -> Dict[str, Any]:
    """解码并验证 Azure AD Bearer token，返回 token 字符串和 claims"""
    if not auth_header or not auth_header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization: Bearer token")

    token = auth_header.split(" ", 1)[1].strip()

    try:
        signing_key = jwk_client.get_signing_key_from_jwt(token).key
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token signing key")

    # 所有可能的 Azure AD issuer 格式
    allowed_issuers = {
        f"https://sts.windows.net/{TENANT_ID}/",
        f"https://login.microsoftonline.com/{TENANT_ID}/v2.0",
        f"https://login.microsoftonline.com/{TENANT_ID}/",
        f"https://login.microsoftonline.com/{TENANT_ID}",
    }

    last_err = None
    for issuer in allowed_issuers:
        try:
            claims = jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                audience=FOUNDRY_AUDIENCE,
                issuer=issuer,
                options={
                    "verify_signature": True,
                    "verify_aud": True,
                    "verify_iss": True,
                    "verify_exp": True,
                },
            )
            return {"token": token, "claims": claims}
        except HTTPException:
            raise
        except Exception as e:
            last_err = e

    raise HTTPException(
        status_code=401,
        detail=f"Token validation failed: {type(last_err).__name__}: {last_err}"
    )


def create_foundry_client_from_token(token: str, claims: Dict[str, Any]) -> AIProjectClient:
    """使用用户 token 创建 Foundry AIProjectClient"""
    exp = int(claims.get("exp", time.time() + 3600))
    cred = BearerTokenCredential(token, exp)
    return AIProjectClient(endpoint=FOUNDRY_PROJECT_ENDPOINT, credential=cred)


# ── Pydantic 模型 ─────────────────────────────────────────────────────
class ApprovalItem(BaseModel):
    """MCP 工具审批项"""
    approval_request_id: str
    approve: bool


class ChatRequest(BaseModel):
    """聊天请求体"""
    agent_name: str
    message: Optional[str] = None
    previous_response_id: Optional[str] = None
    approvals: Optional[List[ApprovalItem]] = None
    action: Optional[str] = None  # "continue" 表示 OAuth 同意后继续


def _get_frontend_runtime_env() -> Dict[str, str]:
    """生成前端运行时环境变量映射。

    参数：
    - 无。

    返回：
    - Dict[str, str]：供 env-config.js 注入到浏览器的前端运行时配置。
    """
    return {
        "REACT_APP_MSAL_CLIENT_ID": _read_env("MSAL_CLIENT_ID"),
        "REACT_APP_MSAL_TENANT_ID": TENANT_ID,
        "REACT_APP_REDIRECT_URI": _read_env("FRONTEND_REDIRECT_URI"),
        "REACT_APP_BACKEND_URL": _read_env("BACKEND_URL"),
        "REACT_APP_AGENT_NAME": _read_env("AGENT_NAME", "FoundryAtlassianAgent"),
    }


def _resolve_frontend_asset_path(requested_path: str) -> Optional[Path]:
    """解析并校验前端静态资源路径。

    参数：
    - requested_path: 浏览器请求的前端静态资源相对路径。

    返回：
    - Optional[Path]：若资源存在且位于 build 目录内则返回绝对路径，否则返回 None。
    """
    if not FRONTEND_BUILD_DIR.is_dir():
        return None

    normalized_path = requested_path.lstrip("/")
    if not normalized_path:
        return FRONTEND_INDEX_FILE if FRONTEND_INDEX_FILE.is_file() else None

    candidate_path = (FRONTEND_BUILD_DIR / normalized_path).resolve()
    try:
        candidate_path.relative_to(FRONTEND_BUILD_DIR.resolve())
    except ValueError:
        return None

    if candidate_path.is_file():
        return candidate_path
    return None


# ── 健康检查 ───────────────────────────────────────────────────────────
@app.get("/health")
def health() -> Dict[str, bool]:
    """健康检查接口"""
    return {"ok": True}


@app.get("/env-config.js", include_in_schema=False)
def frontend_env_config() -> Response:
    """返回前端运行时配置脚本。

    参数：
    - 无。

    返回：
    - Response：包含 window._env_ 的 JavaScript 响应。
    """
    env_payload = json.dumps(_get_frontend_runtime_env(), ensure_ascii=False, indent=2)
    script_content = f"window._env_ = {env_payload};\n"
    return Response(content=script_content, media_type="application/javascript")


# ── 获取 Agent 信息 ───────────────────────────────────────────────────
@app.get("/agents/{agent_name}")
def get_agent(
    agent_name: str,
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """通过 Foundry API 获取指定 Agent 的信息"""
    ctx = decode_and_validate_bearer(authorization)
    project_client = create_foundry_client_from_token(ctx["token"], ctx["claims"])

    try:
        agent = project_client.agents.get(agent_name=agent_name)
        return {"name": agent.name, "id": getattr(agent, "id", None), "type": "foundry_agent"}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Foundry call failed: {type(e).__name__}: {e}")


# ── 辅助函数：提取 Foundry 响应中的特殊输出项 ─────────────────────────
def _extract_special_outputs(response: Any) -> Dict[str, Any]:
    """从 Foundry 响应中提取 OAuth consent link 和 MCP approval 请求"""
    consent_link = None
    approval_requests = []

    for item in getattr(response, "output", []) or []:
        item_type = getattr(item, "type", None)

        if item_type == "oauth_consent_request":
            consent_link = getattr(item, "consent_link", None)

        if item_type == "mcp_approval_request" and getattr(item, "id", None):
            approval_requests.append(
                {
                    "id": item.id,
                    "server_label": getattr(item, "server_label", None),
                    "tool_name": getattr(item, "name", None),
                    "arguments": getattr(item, "arguments", None),
                }
            )

    return {"consent_link": consent_link, "approval_requests": approval_requests}


# ── 聊天接口 ──────────────────────────────────────────────────────────
@app.post("/chat")
def chat(
    req: ChatRequest,
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """聊天主接口：处理用户消息、MCP 审批、OAuth 同意恢复"""
    ctx = decode_and_validate_bearer(authorization)
    return _chat_foundry(req, ctx)


def _chat_foundry(req: ChatRequest, ctx: Dict[str, Any]) -> Dict[str, Any]:
    """通过 Foundry Responses API 处理聊天请求"""
    project_client = create_foundry_client_from_token(ctx["token"], ctx["claims"])

    try:
        agent = project_client.agents.get(agent_name=req.agent_name)
        openai_client = project_client.get_openai_client()

        # 1) OAuth 同意后恢复
        if req.action == "continue":
            if not req.previous_response_id:
                raise HTTPException(
                    status_code=400,
                    detail="previous_response_id is required for action=continue"
                )
            try:
                response = openai_client.responses.create(
                    input=[],
                    previous_response_id=req.previous_response_id,
                    extra_body={
                        "agent_reference": {"name": agent.name, "type": "agent_reference"},
                        "tool_choice": "required",
                    },
                )
            except Exception:
                response = openai_client.responses.create(
                    input=[{"role": "user", "content": "continue"}],
                    previous_response_id=req.previous_response_id,
                    extra_body={
                        "agent_reference": {"name": agent.name, "type": "agent_reference"},
                        "tool_choice": "required",
                    },
                )

        # 2) 提交 MCP 审批
        elif req.approvals and len(req.approvals) > 0:
            if not req.previous_response_id:
                raise HTTPException(
                    status_code=400,
                    detail="previous_response_id is required when submitting approvals"
                )
            input_list = [
                {
                    "type": "mcp_approval_response",
                    "approve": a.approve,
                    "approval_request_id": a.approval_request_id,
                }
                for a in req.approvals
            ]
            response = openai_client.responses.create(
                input=input_list,
                previous_response_id=req.previous_response_id,
                extra_body={"agent_reference": {"name": agent.name, "type": "agent_reference"}},
            )

        # 3) 普通用户消息
        else:
            if not req.message:
                raise HTTPException(
                    status_code=400,
                    detail="message is required when approvals are not provided"
                )
            response = openai_client.responses.create(
                input=[{"role": "user", "content": req.message}],
                extra_body={"agent_reference": {"name": agent.name, "type": "agent_reference"}},
            )

        # 检测特殊输出项（OAuth consent / MCP approvals）
        special = _extract_special_outputs(response)

        if special["consent_link"]:
            return {
                "status": "oauth_consent_required",
                "response_id": response.id,
                "consent_link": special["consent_link"],
            }

        if special["approval_requests"]:
            return {
                "status": "approval_required",
                "response_id": response.id,
                "approval_requests": special["approval_requests"],
            }

        return {
            "status": "ok",
            "response_id": response.id,
            "output_text": getattr(response, "output_text", "") or "",
        }

    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        # 检测 Foundry 错误中嵌入的 consent URL（tool_user_error 场景）
        if "tool_user_error" in error_msg or "Failed Dependency" in error_msg:
            consent_match = re.search(r'(https://logic-apis[^\s\'"\)]+)', error_msg)
            if consent_match:
                return {
                    "status": "oauth_consent_required",
                    "response_id": None,
                    "consent_link": consent_match.group(1),
                    "output_text": "MCP tool authentication expired. Please re-authenticate.",
                }
        raise HTTPException(status_code=502, detail=f"Chat failed: {type(e).__name__}: {e}")


@app.get("/", include_in_schema=False)
@app.head("/", include_in_schema=False)
@app.get("/{requested_path:path}", include_in_schema=False)
@app.head("/{requested_path:path}", include_in_schema=False)
def serve_frontend(requested_path: str = "") -> FileResponse:
    """返回 React 构建产物，并为 SPA 路由回退到 index.html。

    参数：
    - requested_path: 浏览器请求的前端路径，可能是静态资源也可能是前端路由。

    返回：
    - FileResponse：命中资源时返回对应文件，否则返回前端入口 index.html。
    """
    asset_path = _resolve_frontend_asset_path(requested_path)
    if asset_path is not None:
        return FileResponse(asset_path)

    if FRONTEND_INDEX_FILE.is_file():
        return FileResponse(FRONTEND_INDEX_FILE)

    raise HTTPException(
        status_code=404,
        detail="Frontend build not found. Run `npm run build` in `frontend/` first."
    )
