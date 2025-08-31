"""
Main Organized Agent for handling user conversations and task management.
"""

import os
import yaml
from pathlib import Path
from fastapi import HTTPException
from typing import Any, Dict
from beeai_framework.agents.tool_calling import ToolCallingAgent
from beeai_framework.memory import TokenMemory
from beeai_framework.backend import ChatModel
from beeai_framework.adapters.litellm.utils import litellm_debug


from .tools import TasksFileReadTool, TasksFileEditTool

# Configuration path
CONFIG_PATH = Path.home() / ".config" / "organized" / "config.yaml"


def get_config():
    """Loads the configuration from config.yaml."""
    if not CONFIG_PATH.exists():
        raise HTTPException(status_code=500, detail="Config file not found")
    return yaml.safe_load(CONFIG_PATH.read_text())


class OrganizedAgent(ToolCallingAgent):
    """
    Main conversational agent for the Organized application.

    This agent handles all user interactions and can:
    - Read and edit the TASKS.md file
    - Help manage tasks and projects
    - Provide insights and status reports
    - Maintain conversation context
    """

    def __init__(self, gemini_model: str = "gemini-2.5-flash"):
        """
        Initialize the Organized Agent.

        Args:
            gemini_model: Gemini model name to use (e.g., 'gemini-1.5-flash')
        """
        # Load API key from config or environment variable
        config = get_config()
        api_key = config.get("gemini", {}).get("api_key")
        if not api_key:
            # Fall back to environment variable
            api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError(
                "Gemini API key not found in config.yaml or GEMINI_API_KEY environment variable"
            )

        # Set environment variable for BeeAI to use
        os.environ["GEMINI_API_KEY"] = api_key
        litellm_debug(True)

        # Initialize LLM
        llm = ChatModel.from_name(f"gemini:{gemini_model}")
        # llm = GeminiChatModel(model_name=gemini_model)

        # Initialize memory for conversation context
        memory = TokenMemory(llm=llm)

        # Initialize tools
        tools = [
            TasksFileReadTool(),
            TasksFileEditTool(),
        ]

        # Custom templates for system instructions
        templates: Dict[str, Any] = {
            "system": lambda template: template.update(
                defaults={
                    "instructions": """\
You are an AI assistant for the "Organized" personal organization application. You help users manage their tasks, notes, and work history through a structured markdown file (TASKS.md).

Your primary responsibilities:
1. Help users read, understand, and modify their TASKS.md file
2. Assist with task management, prioritization, and organization
3. Provide insights based on the user's work history and notes
4. Maintain helpful and conversational interactions

The TASKS.md file follows this schema:
- Projects are marked with ## headings
- Major tasks are marked with ### headings 
- Tasks can have priority indicators: ⏫ (high), ⬆ (medium)
- Completed tasks are marked with [x] and ✅ date
- Work history entries use + prefix with dates
- Important notes use ★ prefix with dates

When editing TASKS.md:
- Preserve the existing structure and formatting
- Follow the established schema patterns
- Include appropriate context in your edits
- Be precise with text matching for replacements

Always be helpful, concise, and focused on productivity and organization."""
                }
            )
        }

        # Initialize the agent
        super().__init__(llm=llm, tools=tools, memory=memory, templates=templates)
