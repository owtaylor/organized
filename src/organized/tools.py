"""
Custom tools for the Organized agent to interact with the TASKS.md file and other data sources.
"""

from typing import Optional

from beeai_framework.tools import Tool, ToolRunOptions, StringToolOutput
from beeai_framework.emitter import Emitter
from beeai_framework.context import RunContext
from pydantic import BaseModel, Field

from . import tasks


class TasksFileReadInput(BaseModel):
    """Input for reading the TASKS.md file."""

    committed: bool = Field(
        default=False,
        description="If True, read from the last committed version in git. If False, read the current working version.",
    )


class TasksFileReadTool(Tool[TasksFileReadInput, ToolRunOptions, StringToolOutput]):
    """Tool for reading the TASKS.md file content."""

    name = "tasks_file_read"
    description = "Reads the content of the TASKS.md file from the git repository. Can read either the current working version or the last committed version."
    input_schema = TasksFileReadInput

    def _create_emitter(self) -> Emitter:
        return Emitter.root().child(
            namespace=["tool", "tasks_file_read"],
            creator=self,
        )

    async def _run(
        self,
        input_data: TasksFileReadInput,
        options: Optional[ToolRunOptions] = None,
        context: Optional[RunContext] = None,
    ) -> StringToolOutput:
        """Read the TASKS.md file content."""
        content = tasks.read_tasks_file(committed=input_data.committed)
        return StringToolOutput(result=content)


class TasksFileEditInput(BaseModel):
    """Input for editing the TASKS.md file."""

    old_string: str = Field(
        description="The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. For multiple replacements, specify expected_replacements parameter. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail."
    )
    new_string: str = Field(
        description="The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic."
    )
    expected_replacements: Optional[int] = Field(
        default=None,
        description="Number of replacements expected. Defaults to 1 if not specified. Use when you want to replace multiple occurrences.",
    )


class TasksFileEditTool(Tool[TasksFileEditInput, ToolRunOptions, StringToolOutput]):
    """
    Based on https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/edit.ts,
    Copyright 2025 Google LLC, licensed under Apache-2.0
    """

    name = "tasks_file_edit"
    description = """Replaces text within the TASKS.md file. By default, replaces a single occurrence, but can replace multiple occurrences when `expected_replacements` is specified.

Expectation for required parameters:
- `old_string` MUST be the exact literal text to replace, including all whitespace, indentation, and newlines
- `new_string` MUST be the exact literal replacement text, preserving formatting and context
- The `old_string` must uniquely identify the specific text to change
- Include at least 3 lines of context BEFORE and AFTER the target text
- Match whitespace and indentation precisely
- If the string matches multiple locations or doesn't match exactly, the tool will fail
- For multiple replacements, set `expected_replacements` to the number of exact occurrences"""
    input_schema = TasksFileEditInput

    def _create_emitter(self) -> Emitter:
        return Emitter.root().child(
            namespace=["tool", "tasks_file_edit"],
            creator=self,
        )

    async def _run(
        self,
        input_data: TasksFileEditInput,
        options: Optional[ToolRunOptions] = None,
        context: Optional[RunContext] = None,
    ) -> StringToolOutput:
        """Edit the TASKS.md file by replacing text."""

        # Ensure git repo exists
        tasks.ensure_git_repo()

        # Read current content
        current_content = tasks.read_tasks_file(committed=False)

        # Check if old_string exists
        if input_data.old_string not in current_content:
            return StringToolOutput(
                result="Error: Could not find the specified text to replace. The text was not found in TASKS.md."
            )

        # Count occurrences
        occurrence_count = current_content.count(input_data.old_string)

        # Handle expected_replacements validation
        if input_data.expected_replacements is not None:
            if occurrence_count != input_data.expected_replacements:
                return StringToolOutput(
                    result=f"Error: Expected {input_data.expected_replacements} occurrences but found {occurrence_count}."
                )
            # Replace all occurrences
            updated_content = current_content.replace(
                input_data.old_string, input_data.new_string
            )
        else:
            # Default behavior: replace single occurrence
            if occurrence_count > 1:
                return StringToolOutput(
                    result=f"Error: Found {occurrence_count} occurrences of the text. Use 'expected_replacements' parameter to specify the number of replacements."
                )
            # Replace single occurrence
            updated_content = current_content.replace(
                input_data.old_string, input_data.new_string, 1
            )

        # Write back
        tasks.write_tasks_file(updated_content)

        replacements_made = (
            input_data.expected_replacements
            if input_data.expected_replacements is not None
            else 1
        )
        return StringToolOutput(
            result=f"Successfully replaced {replacements_made} occurrence(s) in TASKS.md."
        )
