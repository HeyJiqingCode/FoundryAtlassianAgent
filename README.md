# Foundry Atlassian Agent

React + FastAPI app for chatting with an Azure AI Foundry Agent that uses an Atlassian MCP server.

## Overview

This repo contains:

- A React frontend for Microsoft Entra sign-in and chat UX
- A FastAPI backend that validates the user token and calls Azure AI Foundry on behalf of the user
- Helper scripts for creating/updating the Foundry Agent

At runtime, the backend also serves the built frontend and generates `env-config.js`, so production deployment only needs one container.

## Prerequisites

- Python 3.11+
- Node.js 20+
- An Azure AI Foundry project
- A Microsoft Entra app registration for the frontend
- An MCP connection already configured in your Foundry project
- Azure CLI login for local script usage:

```bash
az login
```

## Install Dependencies

Backend and scripts share one Python dependency file:

```bash
pip install -r requirements.txt
```

Frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

## Create or Update the Foundry Agent

Use the helper script:

```bash
python scripts/create_foundry_agent.py
```

What it does:

- Connects to your Foundry project using `DefaultAzureCredential`
- Looks up the agent by `AGENT_NAME`
- Deletes the latest version if it already exists
- Creates a fresh version with the configured MCP tool
- Applies the configured `AGENT_MODEL`
- Applies the configured `AGENT_REASONING_EFFORT`

## Local Development

Run the frontend and backend separately.

Terminal 1:

```bash
cd frontend
npm start
```

Terminal 2:

```bash
uvicorn backend.foundry_agent_server:app --host 0.0.0.0 --port 8765 --reload
```

Notes:

- `frontend/start-dev.sh` loads values from the root `.env` for local CRA development.
- The frontend runs on `http://localhost:3500`.
- The backend runs on `http://localhost:8765`.

## Build and Run the Container

Build:

```bash
docker build -t foundry-atlassian-agent:0.0.1 .
```

Run:

```bash
docker run -p 8765:8765 \
  -e MSAL_CLIENT_ID="your-azure-ad-client-id" \
  -e AZURE_TENANT_ID="your-azure-ad-tenant-id" \
  -e FOUNDRY_PROJECT_ENDPOINT="https://your-foundry-account.services.ai.azure.com/api/projects/your-foundry-project" \
  -e FRONTEND_REDIRECT_URI="https://your-app-domain" \
  -e AGENT_NAME="FoundryAtlassianAgent" \
  foundry-atlassian-agent:0.0.1
```

The app is then available at:

```text
http://localhost:8765
```
