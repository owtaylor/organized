# Agent Design for Organized Project (Simplified)

## Overview

This document outlines a simplified design for integrating a single BeeAI agent into the Organized personal organization application. The interface will be a chat-based system that allows users to interact with their tasks, notes, and work history through natural language.

## Architecture Decision

**Direct BeeAI API Integration** - A single agent will be integrated directly into the FastAPI application rather than using multiple specialized agents or a separate agent server. This provides:
- Simpler architecture with unified codebase
- Lower latency with direct function calls
- Easier debugging and development
- Better integration with existing FastAPI endpoints
- Appropriate for single-user, local deployment scenario

## Simplified Agent Architecture

```
User Chat Message
       ↓
Main Agent (Single conversational handler)
       ↓
Tool Selection & Execution
       ↓
Response Generation
       ↓
User Response
```

### Single Agent Responsibilities

**Main Organized Agent**
- Handle all conversation and request routing
- Determine which tools to use for each request
- Synthesize information from multiple tool calls
- Maintain conversation flow and context
- Support all functionality areas:
  - Task management and TASKS.md operations
  - Audio note processing and analysis
  - Status reporting and Git history analysis
  - Context management and memory

## Memory Strategy

- **Primary Memory**: BeeAI's `SummarizeMemory` or `TokenMemory` for conversation context
- **Persistent Context**: Store long-term user preferences and project context in Git repository
- **Session Memory**: Maintain conversation state during active chat sessions

## Tool Integration

### Core Tools for Phase 1

1. **TasksFileReadTool**: Reads the current TASKS.md file content
2. **TasksFileEditTool**: Edits TASKS.md by replacing specific text content

The edit tool should be based on the interface from the Gemini CLI edit tool:
- **Reference**: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/edit.ts
- **Modifications**: No path parameter (fixed to TASKS.md), user cannot edit the new_string
- **Philosophy**: Let the agent handle parsing and understanding the markdown format

### Additional Tools for Later Phases

- **GitAnalysisTool**: Extract commit history and work patterns
- **NoteProcessingTool**: Interface with existing `notes.py` functionality
- **FileSystemTool**: Read/write configuration and data files
- **StatusReportTool**: Generate reports from various data sources

### Tool Implementation Guidelines

BeeAI tools should be implemented by subclassing the `Tool` base class:
- **Documentation**: https://framework.beeai.dev/modules/tools
- **Pattern**: Subclass `Tool[InputModel, ToolRunOptions, OutputModel]`
- **Required**: Define `name`, `description`, `input_schema` class attributes
- **Method**: Implement async `_run()` method
- **Output**: Return `StringToolOutput` or `JSONToolOutput`

## FastAPI Integration

### New Endpoints

```python
# Chat Interface
POST /api/chat                    # Main chat endpoint
GET  /api/chat/history           # Conversation history
POST /api/chat/clear             # Reset conversation
WebSocket /ws/chat               # Real-time streaming chat (future)

# Agent Management
GET  /api/agents/status          # Agent health and configuration
POST /api/agents/reset           # Reset agent memory
```

### Implementation Structure

```
src/organized/
├── main.py              # Existing FastAPI app
├── notes.py             # Existing audio notes functionality
├── agent.py             # New: Single BeeAI agent definition
├── tools.py             # New: Custom tools for agent
└── chat.py              # New: Chat endpoint handlers
```

## Example Chat Interactions

- "Add a high-priority task to review the Q4 budget"
- "Generate a status report for this week"
- "What insights can you extract from my recent audio notes?"
- "Show me all tasks related to the mobile app project"
- "What have I been working on lately based on my Git commits?"
- "Help me prioritize my current tasks"

## LLM Provider Integration

- **Primary LLM**: Google Gemini (already configured in the project)
- **Configuration**: Use existing config.yaml structure
- **API Key Management**: Leverage existing Gemini API key setup

## Implementation Phases

### Phase 1: Foundation
- Create single Main Organized Agent
- Implement basic TASKS.md tools (read/edit)
- Set up chat endpoints
- Basic conversation memory

### Phase 2: Enhanced Tools
- Add Git analysis tools
- Implement note processing tools
- Create status reporting capabilities
- Enhanced memory management

### Phase 3: Advanced Features
- Cross-source data correlation
- Intelligent task suggestions
- WebSocket streaming chat
- Performance optimization

### Phase 4: Polish
- User preference learning
- Advanced context management
- Error handling improvements
- UI/UX enhancements

## Benefits of Single Agent Approach

1. **Simplicity**: Easier to implement, debug, and maintain
2. **Flexibility**: Single agent can adapt its behavior based on context
3. **Coherent Responses**: No need to coordinate between multiple agents
4. **Tool-Based Modularity**: Functionality is separated into tools rather than agents
5. **Future Extensibility**: Can evolve into multi-agent system later if needed

## Technology Stack

- **Agent Framework**: BeeAI Framework (Python)
- **LLM Provider**: Google Gemini
- **Backend**: FastAPI
- **Memory**: BeeAI memory strategies + local file storage
- **Data Storage**: Git repository with structured markdown
- **Configuration**: YAML (existing structure)