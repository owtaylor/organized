"""
Chat endpoints for the Organized agent interface.
"""

import json
import logging
from typing import Dict, List, Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from beeai_framework.backend.message import MessageToolCallContent

from .agent import OrganizedAgent

# Configure logging
logger = logging.getLogger(__name__)

# Global agent instance
_agent_instance: Optional[OrganizedAgent] = None

# Chat router
router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatMessage(BaseModel):
    """Chat message model."""

    message: str


class ChatResponse(BaseModel):
    """Chat response model."""

    response: str
    session_id: Optional[str] = None


class ChatHistoryResponse(BaseModel):
    """Chat history response model."""

    messages: List[Dict[str, str]]


def get_agent() -> OrganizedAgent:
    """Get or create the agent instance."""
    global _agent_instance
    if _agent_instance is None:
        _agent_instance = OrganizedAgent()
    return _agent_instance


@router.post("", response_model=ChatResponse)
async def chat(message: ChatMessage, agent: OrganizedAgent = Depends(get_agent)):
    """
    Main chat endpoint for interacting with the Organized agent.

    Args:
        message: The user message to process
        agent: The agent instance (injected via dependency)

    Returns:
        The agent's response
    """

    # Run the agent with the user's message
    response = await agent.run(message.message)

    return ChatResponse(
        response=response.result.text,
        session_id=None,  # For future session management
    )


@router.get("/history", response_model=ChatHistoryResponse)
async def get_chat_history(agent: OrganizedAgent = Depends(get_agent)):
    """
    Get the conversation history from the agent's memory.

    Args:
        agent: The agent instance (injected via dependency)

    Returns:
        The conversation history
    """
    try:
        # Get messages from agent memory
        messages = agent.memory.messages

        # Extract only user messages and final assistant responses
        history = []

        for msg in messages:
            if str(msg.role) == "user":
                history.append({"role": "user", "content": msg.text})
            elif str(msg.role) == "assistant":
                # Look for final_answer tool calls
                for content_item in msg.content:
                    if (
                        isinstance(content_item, MessageToolCallContent)
                        and content_item.tool_name == "final_answer"
                    ):
                        try:
                            args = json.loads(content_item.args)
                            response = args.get("response", "")
                            if response:
                                history.append(
                                    {"role": "assistant", "content": response}
                                )
                        except:
                            pass

        return ChatHistoryResponse(messages=history)

    except Exception as e:
        logger.error(f"Error getting chat history: {e}")
        raise HTTPException(
            status_code=500, detail=f"Error retrieving chat history: {str(e)}"
        )


@router.post("/clear")
async def clear_chat(agent: OrganizedAgent = Depends(get_agent)):
    """
    Clear the conversation history and reset the agent's memory.

    Args:
        agent: The agent instance (injected via dependency)

    Returns:
        Success message
    """
    try:
        # Clear the agent's memory
        agent.memory.reset()

        return {"message": "Chat history cleared successfully"}

    except Exception as e:
        logger.error(f"Error clearing chat: {e}")
        raise HTTPException(
            status_code=500, detail=f"Error clearing chat history: {str(e)}"
        )


@router.get("/status")
async def get_agent_status(agent: OrganizedAgent = Depends(get_agent)):
    """
    Get the current status and configuration of the agent.

    Args:
        agent: The agent instance (injected via dependency)

    Returns:
        Agent status information
    """
    try:
        # Get basic agent info
        status = {
            "status": "active",
            "agent_type": type(agent).__name__,
            "tools_count": len(agent.meta.tools)
            if agent.meta and hasattr(agent.meta, "tools")
            else 0,
            "memory_type": type(agent.memory).__name__
            if hasattr(agent, "memory")
            else "unknown",
        }

        # Add tool information
        if agent.meta and hasattr(agent.meta, "tools"):
            status["available_tools"] = [tool.name for tool in agent.meta.tools]

        return status

    except Exception as e:
        logger.error(f"Error getting agent status: {e}")
        raise HTTPException(
            status_code=500, detail=f"Error retrieving agent status: {str(e)}"
        )


@router.post("/reset")
async def reset_agent():
    """
    Reset the agent by creating a new instance.
    This clears all memory and reinitializes the agent.

    Returns:
        Success message
    """
    try:
        global _agent_instance
        _agent_instance = None  # This will force creation of a new instance

        return {"message": "Agent reset successfully"}

    except Exception as e:
        logger.error(f"Error resetting agent: {e}")
        raise HTTPException(status_code=500, detail=f"Error resetting agent: {str(e)}")
