"""在 Azure AI Foundry 中创建/更新 Agent，只挂载 MCP 工具（mcp-atlassian）。

运行方式：
  pip install -r requirements.txt
  python scripts/create_foundry_agent.py
"""
import os
from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential
from azure.ai.projects.models import PromptAgentDefinition, Reasoning
from dotenv import load_dotenv

load_dotenv()

# ── 从环境变量读取配置 ──────────────────────────────────────────────
foundry_project_endpoint: str | None = os.getenv("FOUNDRY_PROJECT_ENDPOINT")
agent_name: str | None = os.getenv("AGENT_NAME")
mcp_tool_server_label: str | None = os.getenv("MCP_TOOL_SERVER_NAME")
mcp_tool_server_url: str | None = os.getenv("MCP_TOOL_SERVER_URL")
mcp_project_connection_id: str | None = os.getenv("MCP_PROJECT_CONNECTION_ID")
agent_model: str | None = os.getenv("AGENT_MODEL")
agent_reasoning_effort: str = os.getenv("AGENT_REASONING_EFFORT", "high")
agent_mcp_require_approval: str = os.getenv("AGENT_MCP_REQUIRE_APPROVAL")

# 检查必填环境变量
required_vars = {
    "FOUNDRY_PROJECT_ENDPOINT": foundry_project_endpoint,
    "AGENT_NAME": agent_name,
    "AGENT_MODEL": agent_model,
    "MCP_TOOL_SERVER_NAME": mcp_tool_server_label,
    "MCP_TOOL_SERVER_URL": mcp_tool_server_url,
    "MCP_PROJECT_CONNECTION_ID": mcp_project_connection_id,
}
missing = [k for k, v in required_vars.items() if not v]
if missing:
    print(f"Missing environment variables: {', '.join(missing)}")
    print("Please set them in the .env file.")
    exit(1)

# ── 初始化 Foundry 客户端 ──────────────────────────────────────────
client = AIProjectClient(
    endpoint=foundry_project_endpoint,
    credential=DefaultAzureCredential()
)

# ── 删除已有同名 Agent（不存在则跳过） ──────────────────────────────
try:
    agent = client.agents.get(agent_name=agent_name)
    print(f"Agent already exists (id: {agent.id}, name: {agent.name}), "
          f"version: {agent.versions.latest.version} - Deleting it...")
    client.agents.delete_version(
        agent_name=agent.name,
        agent_version=agent.versions.latest.version
    )
    print(f"Deleted existing agent (id: {agent.id}, name: {agent.name})")
except Exception:
    print(f"Agent '{agent_name}' not found, will create a new one.")

# ── 创建新 Agent（只挂载 MCP 工具） ──────────────────────────────────
agent = client.agents.create_version(
    agent_name=agent_name,
    definition=PromptAgentDefinition(
        model=agent_model,
        reasoning=Reasoning(effort=agent_reasoning_effort),
        instructions="""
        You are a Jira and Confluence assistant powered by mcp-atlassian.
        You can answer questions related to Jira issues, Confluence pages, and project management.

        Guidelines:
        - Use the attached MCP tools to fetch Jira issues, search Confluence pages, and provide relevant information.
        - If the tool returns URLs, format them as clickable links in markdown.
        - Always state which tool you are using.
        - If you cannot find the answer using the tools, respond with "I don't know".
        """,
        tools=[
            {
                "type": "mcp",
                "server_label": mcp_tool_server_label,
                "server_url": mcp_tool_server_url,
                "project_connection_id": mcp_project_connection_id,
                "require_approval": agent_mcp_require_approval,
            },
        ],
    ),
)
print(f"Agent created (id: {agent.id}, name: {agent.name}, version: {agent.version})")
