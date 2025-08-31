# BeeAI Framework Cheat Sheet

## Overview

BeeAI Framework is a comprehensive toolkit for building intelligent, autonomous agents and multi-agent systems. It provides everything needed to create agents that can reason, take actions, and collaborate to solve complex problems.

### Key Features
- 🤖 **Agents**: Multiple agent types (ReAct, ToolCalling, Custom, Experimental)
- 🔄 **Workflows**: Multi-agent orchestration with complex execution flows
- 🔌 **Backend**: Unified interface for 10+ LLM providers
- 🔧 **Tools**: Extensible tool system for external integrations
- 🧠 **Memory**: Multiple memory strategies for conversation state
- 🚀 **Serve**: Host agents as servers with protocol support (ACP, MCP)
- 📊 **Observability**: Event-driven architecture for monitoring

## Quick Start

### Installation
```bash
pip install beeai-framework
```

### Basic Agent Example
```python
import asyncio
from beeai_framework.agents.react import ReActAgent
from beeai_framework.backend import ChatModel
from beeai_framework.memory import UnconstrainedMemory
from beeai_framework.tools.weather import OpenMeteoTool

async def main():
    agent = ReActAgent(
        llm=ChatModel.from_name("ollama:llama3.1"),
        tools=[OpenMeteoTool()],
        memory=UnconstrainedMemory()
    )
    
    response = await agent.run("What's the weather in Paris?")
    print(response.result.text)

asyncio.run(main())
```

## Core APIs

### Agent Creation

#### ReAct Agent (Reasoning + Acting Pattern)
```python
from beeai_framework.agents.react import ReActAgent
from beeai_framework.agents import AgentExecutionConfig

agent = ReActAgent(
    llm=ChatModel.from_name("ollama:granite3.3:8b"),
    tools=[WikipediaTool(), OpenMeteoTool()],
    memory=TokenMemory(llm)
)

# With execution configuration
response = await agent.run(
    prompt="Your query here",
    execution=AgentExecutionConfig(
        max_retries_per_step=3,
        total_max_retries=10,
        max_iterations=20
    )
)
```

#### Tool Calling Agent (Optimized for Tool Usage)
```python
from beeai_framework.agents.tool_calling import ToolCallingAgent

agent = ToolCallingAgent(
    llm=ChatModel.from_name("ollama:llama3.1"),
    memory=UnconstrainedMemory(),
    tools=[OpenMeteoTool()]
)

response = await agent.run("Get weather for Boston")
```

#### Custom Agent
```python
from beeai_framework.agents import BaseAgent
from pydantic import BaseModel

class CustomAgentOutput(BaseModel):
    message: str
    confidence: float

class CustomAgent(BaseAgent[CustomAgentOutput]):
    async def _run(self, input, options, context):
        # Custom logic here
        return CustomAgentOutput(message="Done", confidence=0.95)
```

### Backend (LLM Integration)

#### Chat Models
```python
from beeai_framework.backend import ChatModel, UserMessage

# Factory method
llm = ChatModel.from_name("ollama:llama3.1")

# Direct instantiation
from beeai_framework.adapters.ollama import OllamaChatModel
llm = OllamaChatModel("llama3.1")

# Basic usage
response = await llm.create(messages=[UserMessage("Hello")])
print(response.get_text_content())

# Streaming
response = await llm.create(
    messages=[UserMessage("Tell me a story")],
    stream=True
).on("new_token", lambda data, event: print(data.value.get_text_content()))

# Structured output
from pydantic import BaseModel, Field

class PersonSchema(BaseModel):
    name: str = Field(description="Person's name")
    age: int = Field(description="Person's age")

response = await llm.create_structure(
    schema=PersonSchema,
    messages=[UserMessage("Generate a person profile")]
)
print(response.object)  # PersonSchema instance
```

#### Supported Providers
- **Ollama**: `ollama:model-name`
- **OpenAI**: `openai:gpt-4`
- **Watsonx**: `watsonx:ibm/granite-3-8b-instruct`
- **Groq**: `groq:mixtral-8x7b-32768`
- **Amazon Bedrock**, **Google Vertex**, **Anthropic**, **xAI**, **MistralAI**

### Memory Management

#### Memory Types
```python
from beeai_framework.memory import (
    UnconstrainedMemory,    # Unlimited storage
    SlidingMemory,          # Keep last K messages
    TokenMemory,            # Token-based limits
    SummarizeMemory         # Compressed summaries
)

# Unconstrained Memory
memory = UnconstrainedMemory()
await memory.add(UserMessage("Hello"))
await memory.add_many([UserMessage("Hi"), AssistantMessage("Hello!")])

# Sliding Memory (keeps last 3 messages)
memory = SlidingMemory(SlidingMemoryConfig(
    size=3,
    handlers={"removal_selector": lambda msgs: msgs[0]}  # Remove oldest
))

# Token Memory (manages token limits)
memory = TokenMemory(
    llm=llm,
    max_tokens=4000,
    capacity_threshold=0.75
)

# Summarize Memory (maintains conversation summary)
memory = SummarizeMemory(llm)
```

### Tools

#### Built-in Tools
```python
from beeai_framework.tools.search.duckduckgo import DuckDuckGoSearchTool
from beeai_framework.tools.search.wikipedia import WikipediaTool
from beeai_framework.tools.weather import OpenMeteoTool
from beeai_framework.tools.code import PythonTool, LocalPythonStorage

# Usage
weather_tool = OpenMeteoTool()
search_tool = DuckDuckGoSearchTool()
wiki_tool = WikipediaTool()

# Python execution tool
python_tool = PythonTool(
    code_interpreter_url="http://127.0.0.1:50081",
    storage=LocalPythonStorage(
        local_working_dir="/tmp/local",
        interpreter_working_dir="/tmp/interpreter"
    )
)
```

#### Custom Tools
```python
from beeai_framework.tools import Tool, StringToolOutput
from pydantic import BaseModel, Field

class CalculatorInput(BaseModel):
    expression: str = Field(description="Math expression to evaluate")

class CalculatorTool(Tool[CalculatorInput, ToolRunOptions, StringToolOutput]):
    name = "Calculator"
    description = "Evaluates mathematical expressions"
    input_schema = CalculatorInput
    
    async def _run(self, input: CalculatorInput, options, context):
        result = eval(input.expression)  # Note: Use safe eval in production
        return StringToolOutput(str(result))

# Using decorator approach
from beeai_framework.tools import tool

@tool
def simple_calculator(expression: str) -> StringToolOutput:
    """Calculate mathematical expressions."""
    result = eval(expression)
    return StringToolOutput(str(result))
```

### Workflows

#### Simple Workflow
```python
from beeai_framework.workflows import Workflow
from pydantic import BaseModel

class State(BaseModel):
    counter: int = 0
    result: str = ""

workflow = Workflow(State)
workflow.add_step("increment", lambda state: setattr(state, 'counter', state.counter + 1))
workflow.add_step("format", lambda state: setattr(state, 'result', f"Count: {state.counter}"))

response = await workflow.run(State())
print(response.state.result)
```

#### Multi-Agent Workflow
```python
from beeai_framework.workflows.agent import AgentWorkflow, AgentWorkflowInput

workflow = AgentWorkflow(name="Research Assistant")

workflow.add_agent(
    name="Researcher",
    role="Research specialist",
    instructions="Look up detailed information on topics",
    tools=[WikipediaTool()],
    llm=llm
)

workflow.add_agent(
    name="Synthesizer", 
    role="Information synthesizer",
    instructions="Combine information into coherent summaries",
    llm=llm
)

response = await workflow.run(inputs=[
    AgentWorkflowInput(prompt="Research topic X", context="user query"),
    AgentWorkflowInput(prompt="Summarize findings", expected_output="Brief summary")
])
```

### Event Handling

#### Observing Agent Events
```python
def process_events(data, event):
    if event.name == "update":
        print(f"Agent update: {data.update.parsed_value}")
    elif event.name == "error":
        print(f"Error: {data.error}")

response = await agent.run("query").on("*", process_events)

# Or with lambda
response = await agent.run("query").on(
    "update", 
    lambda data, event: print(f"Agent: {data.update.parsed_value}")
)
```

#### Event Types by Component
- **ReActAgent**: `start`, `success`, `error`, `retry`, `update`, `partial_update`, `tool_start`, `tool_success`, `tool_error`
- **ChatModel**: `start`, `success`, `error`, `new_token`, `finish`
- **Tools**: `start`, `success`, `error`, `retry`, `finish`
- **Workflows**: `start`, `success`, `error`

### Serving Agents

#### Basic Server Setup
```python
from beeai_framework.adapters.acp import ACPServer, ACPServerConfig

# Create agent
agent = ToolCallingAgent(
    llm=ChatModel.from_name("ollama:granite3.3"),
    tools=[],
    memory=UnconstrainedMemory()
)

# Create server
server = ACPServer(config=ACPServerConfig(port=8001))
server.register(agent)
server.serve()  # Starts the server
```

#### Supported Protocols
- **ACP (Agent Communication Protocol)**: `beeai_framework.adapters.acp.serve`
- **MCP (Model Context Protocol)**: `beeai_framework.adapters.mcp.serve`
- **BeeAI Platform**: `beeai_framework.adapters.beeai_platform.serve`

## Interactive Chat Agent Pattern

### CLI-based Interactive Agent
```python
from examples.helpers.io import ConsoleReader

async def create_interactive_agent():
    reader = ConsoleReader()
    agent = ReActAgent(
        llm=ChatModel.from_name("ollama:granite3.3:8b"),
        tools=[WikipediaTool(), OpenMeteoTool(), DuckDuckGoSearchTool()],
        memory=TokenMemory(llm)
    )
    
    reader.write("🛠️ System: ", "Agent initialized. Ask me anything!")
    
    for prompt in reader:
        response = await agent.run(
            prompt=prompt,
            execution=AgentExecutionConfig(max_iterations=10)
        ).on("update", lambda data, event: 
            reader.write(f"Agent({data.update.key}) 🤖: ", data.update.parsed_value)
        )
        
        reader.write("Agent 🤖: ", response.result.text)

# Usage
asyncio.run(create_interactive_agent())
```

### Web-based Chat Agent (Framework-agnostic)
```python
class ChatAgent:
    def __init__(self):
        self.agent = ReActAgent(
            llm=ChatModel.from_name("ollama:granite3.3:8b"),
            tools=[WikipediaTool(), OpenMeteoTool()],
            memory=UnconstrainedMemory()
        )
    
    async def process_message(self, user_message: str, session_id: str):
        """Process a user message and return response"""
        # Add session-specific memory management if needed
        response = await self.agent.run(user_message)
        return {
            "response": response.result.text,
            "session_id": session_id
        }
    
    async def stream_response(self, user_message: str, session_id: str):
        """Stream response chunks for real-time chat"""
        chunks = []
        
        response = await self.agent.run(user_message).on(
            "update",
            lambda data, event: chunks.append({
                "type": "update",
                "content": data.update.parsed_value,
                "key": data.update.key
            })
        )
        
        # Yield chunks for streaming
        for chunk in chunks:
            yield chunk
            
        yield {
            "type": "final", 
            "content": response.result.text
        }
```

## Configuration and Best Practices

### Environment Variables
```bash
# Ollama
OLLAMA_BASE_URL=http://localhost:11434

# OpenAI
OPENAI_API_KEY=your_key_here
OPENAI_BASE_URL=https://api.openai.com/v1

# Watsonx
WATSONX_API_KEY=your_key
WATSONX_PROJECT_ID=your_project_id

# Code Interpreter
CODE_INTERPRETER_URL=http://127.0.0.1:50081
```

### Error Handling
```python
from beeai_framework.errors import FrameworkError, AgentError

try:
    response = await agent.run("query")
except FrameworkError as e:
    print(f"Framework error: {e.explain()}")
except AgentError as e:
    print(f"Agent error: {e}")
```

### Performance Tips
1. **Use TokenMemory** for production to manage context limits
2. **Cache tools** when possible to reduce external API calls
3. **Stream responses** for better user experience
4. **Use appropriate memory strategies** based on conversation length
5. **Configure retry policies** for robust error handling

## Common Patterns

### 1. Research Assistant Pattern
```python
research_agent = ReActAgent(
    llm=ChatModel.from_name("ollama:granite3.3:8b"),
    tools=[DuckDuckGoSearchTool(), WikipediaTool()],
    memory=SummarizeMemory(llm)
)
```

### 2. Code Assistant Pattern  
```python
code_agent = ReActAgent(
    llm=ChatModel.from_name("ollama:granite3.3:8b"),
    tools=[PythonTool(...)],
    memory=TokenMemory(llm, max_tokens=8000)
)
```

### 3. Multi-Modal Pattern
```python
# For handling images, documents, etc.
multimodal_agent = ReActAgent(
    llm=ChatModel.from_name("watsonx:meta-llama/llama-3-2-11b-vision-instruct"),
    tools=[VectorStoreSearchTool(vector_store)],
    memory=UnconstrainedMemory()
)
```

## File References

- **Main Documentation**: `/docs/modules/`
- **Python Examples**: `/python/examples/`
- **Agent Examples**: `/python/examples/agents/`
- **Tool Examples**: `/python/examples/tools/`
- **Workflow Examples**: `/python/examples/workflows/`
- **Backend Examples**: `/python/examples/backend/`
- **Serve Examples**: `/python/examples/serve/`

## Quick Reference Commands

```python
# Create agent
agent = ReActAgent(llm, tools, memory)

# Run agent
response = await agent.run("query")

# With events
response = await agent.run("query").on("update", callback)

# Chat model
llm = ChatModel.from_name("provider:model")
response = await llm.create(messages=[UserMessage("text")])

# Tools
tool = CustomTool()
result = await tool.run(input_data)

# Memory
memory = UnconstrainedMemory()
await memory.add(UserMessage("text"))

# Workflows  
workflow = Workflow(StateClass)
workflow.add_step("name", step_function)
result = await workflow.run(initial_state)
```

This cheat sheet covers the essential APIs and patterns for building interactive chat agents with the BeeAI framework. Refer to the full documentation and examples for more detailed implementations.