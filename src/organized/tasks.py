"""
Centralized module for handling TASKS.md file operations.
"""

import subprocess
import yaml
from pathlib import Path
from typing import Tuple, Dict, Any

# Constants
GIT_CHECKOUT_LOCATION = Path.home() / ".local" / "share" / "organized" / "main"
TASKS_FILE_PATH = GIT_CHECKOUT_LOCATION / "TASKS.md"


def extract_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    """
    Extracts YAML frontmatter from the content.
    Returns tuple of (frontmatter_dict, content_without_frontmatter)
    """
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            return yaml.safe_load(parts[1]), parts[2].lstrip()
    return {}, content


def get_default_tasks_content() -> str:
    """Returns the default TASKS.md content when file doesn't exist."""
    return """## My First project

This is a description of my first project. It might be quite long.

### Major task in My First Project

This is the description of the major task.

★ 2025-07-13: I talked to somebody and found out an interesting "tidbit" that I want to appear in my next status report.

- [ ] Subtask in task
    + 2025-07-13: I did some work on this subtask
- [ ] ⏫ High priority subtask
- [ ] ⬆ Medium priority task
- [x] Completed subtask (✅ 2025-04-17)
- [x] Completed subtask with history
    + 2025-05-20 talked to someone about this
    + ✅ 2025-05-17

### Completed major task in My First Project (✅ 2025-06-10)

[...]

### Other
- [ ] This is a quick task not related to any major task

## My second project
[...]

## Other Work

- [ ] ⏫ This is a random import task not related to any project
"""


def ensure_git_repo():
    """Ensures the git repository exists and is initialized."""
    if not GIT_CHECKOUT_LOCATION.exists():
        GIT_CHECKOUT_LOCATION.mkdir(parents=True, exist_ok=True)

    if not (GIT_CHECKOUT_LOCATION / ".git").exists():
        subprocess.run(["git", "init"], cwd=GIT_CHECKOUT_LOCATION, check=True)


def read_tasks_file(committed: bool = False) -> str:
    """
    Reads the content of TASKS.md from the git repository.

    Args:
        committed: If True, read from the last committed version in git.
                  If False, read the current working version.

    Returns:
        The content of TASKS.md without frontmatter.
    """
    if not TASKS_FILE_PATH.exists():
        return get_default_tasks_content()

    if committed:
        try:
            content = subprocess.run(
                ["git", "show", "HEAD:TASKS.md"],
                cwd=GIT_CHECKOUT_LOCATION,
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        except subprocess.CalledProcessError:
            # Handle case where file doesn't exist in git history
            return ""
    else:
        content = TASKS_FILE_PATH.read_text()

    _, content_without_frontmatter = extract_frontmatter(content)
    return content_without_frontmatter


def write_tasks_file(new_content: str) -> None:
    """
    Writes content to TASKS.md in the git repository.
    Preserves any existing frontmatter.

    Args:
        new_content: The new content to write (without frontmatter).
    """
    ensure_git_repo()

    # Get existing frontmatter if file exists
    existing_frontmatter = {}
    if TASKS_FILE_PATH.exists():
        existing_frontmatter, _ = extract_frontmatter(TASKS_FILE_PATH.read_text())

    # Add frontmatter back if it existed
    if existing_frontmatter:
        final_content = (
            "---\n" + yaml.dump(existing_frontmatter) + "---\n\n" + new_content
        )
    else:
        final_content = new_content

    TASKS_FILE_PATH.write_text(final_content)
