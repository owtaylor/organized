"""
FileSystem module for managing file operations with git integration.

This module implements a filesystem abstraction layer that provides
real-time file synchronization, conflict resolution, and git integration
as specified in FILESYSTEM_DESIGN.md.
"""

import abc
import asyncio
import logging
import os
import subprocess
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Callable, AsyncIterator, Tuple

from watchfiles import awatch, Change
from diff_match_patch import diff_match_patch

logger = logging.getLogger(__name__)


@dataclass
class File:
    """Represents a file with its current state."""

    content: str
    ref_count: int = 0
    mtime: float = 0.0


class FileSystemWatcher(abc.ABC):
    """Abstract base class for objects that watch file system changes."""

    @abc.abstractmethod
    def on_file_change(self, filename: str, content: str, source_handle: Optional[str] = None) -> None:
        """Called when a file changes.

        Args:
            filename: The path of the file that changed
            content: The new content of the file
            source_handle: Handle that caused the change (None for external changes)
        """
        pass


class FileSystem:
    """
    Core filesystem abstraction that manages file operations,
    reference counting, and git integration.
    """

    def __init__(self, repository_path: Path):
        """
        Initialize the FileSystem with a git repository.

        Args:
            repository_path: Path to the git repository directory

        Raises:
            ValueError: If the path doesn't exist or isn't a git repository
        """
        self.repository_path = Path(repository_path).resolve()

        # Validate the repository path
        if not self.repository_path.exists():
            raise ValueError(f"Repository path does not exist: {repository_path}")

        if not self.repository_path.is_dir():
            raise ValueError(f"Repository path is not a directory: {repository_path}")

        # Check if it's a git repository
        git_dir = self.repository_path / ".git"
        if not git_dir.exists():
            raise ValueError(f"Path is not a git repository: {repository_path}")

        # Initialize internal state
        self.files: Dict[str, File] = {}
        self.watchers: List[FileSystemWatcher] = []

        # Git HEAD tracking
        self._git_head_file = self.repository_path / ".git" / "HEAD"
        self._current_head_commit: Optional[str] = None
        self._current_ref_file: Optional[Path] = None  # File to watch for ref changes

    def _normalize_and_validate_path(self, filename: str) -> Path:
        """
        Validate a file path to prevent directory traversal and ensure it's normalized.

        Args:
            filename: The input filename/path (must be already normalized)

        Returns:
            Absolute Path object within the repository

        Raises:
            ValueError: If the path attempts to escape the repository or is not normalized
        """
        # Convert to Path object
        path = Path(filename)

        # Check if the path is already normalized (no . or .. components, no double slashes)
        normalized_path = Path(os.path.normpath(filename))
        if str(path) != str(normalized_path):
            raise ValueError(
                f"Path '{filename}' is not normalized. Use '{normalized_path}' instead."
            )

        # Additional checks for problematic patterns
        if ".." in path.parts or "." in path.parts:
            raise ValueError(f"Path '{filename}' contains '.' or '..' components")

        # Check for absolute paths (should be relative to repository)
        if path.is_absolute():
            raise ValueError(f"Path '{filename}' must be relative to repository root")

        # Convert to absolute path within repository context
        absolute_path = self.repository_path / path

        # NOTE: We don't use .resolve() here to avoid symlink-based escapes because:
        # 1. resolve() checks are racy (symlinks can be created between check and use)
        # 2. Our main defense is not providing any facility to create symlinks
        # 3. For proper symlink defense, we would need to resolve paths ourselves
        #    using O_NOFOLLOW and O_DIRECTORY flags during file operations

        return absolute_path

    def open_file(self, filename: str) -> str:
        """
        Open a file and increment its reference count.

        Args:
            filename: Path to the file relative to repository root.
                     Use @filename to open the committed version from git.

        Returns:
            Current content of the file

        Raises:
            FileNotFoundError: If the file doesn't exist
            ValueError: If the path attempts to escape the repository or is not normalized
        """
        if self._is_committed_file_path(filename):
            # Handle @file paths (committed versions)
            git_file_path = self._extract_git_file_path(filename)

            # Validate the extracted path (without @)
            self._normalize_and_validate_path(git_file_path)

            if filename not in self.files:
                # First time opening this committed file
                content = self._read_file_from_git(git_file_path)

                # For committed files, we don't track mtime from disk
                # Instead, we could track the commit hash, but for now use 0
                self.files[filename] = File(content=content, ref_count=1, mtime=0.0)
            else:
                # File already open, increment reference count
                self.files[filename].ref_count += 1

        else:
            # Handle regular file paths (working directory)
            file_path = self._normalize_and_validate_path(filename)

            if filename not in self.files:
                # First time opening this file
                if not file_path.exists():
                    raise FileNotFoundError(f"File not found: {filename}")

                # Stat first, then read to avoid race condition
                file_stat = file_path.stat()
                content = file_path.read_text(encoding="utf-8")

                self.files[filename] = File(
                    content=content, ref_count=1, mtime=file_stat.st_mtime
                )
            else:
                # File already open, increment reference count
                self.files[filename].ref_count += 1

        return self.files[filename].content

    def close_file(self, filename: str) -> None:
        """
        Close a file and decrement its reference count.

        Args:
            filename: Path to the file relative to repository root
        """
        if filename in self.files:
            self.files[filename].ref_count -= 1

            # Remove from tracking if no longer referenced
            if self.files[filename].ref_count <= 0:
                del self.files[filename]

    def add_watcher(self, watcher: FileSystemWatcher) -> None:
        """Add a watcher to be notified of file changes."""
        self.watchers.append(watcher)

    def remove_watcher(self, watcher: FileSystemWatcher) -> None:
        """Remove a watcher from notifications."""
        if watcher in self.watchers:
            self.watchers.remove(watcher)

    def write_file(
        self,
        filename: str,
        last_content: str,
        content: str,
        source: Optional[Tuple[FileSystemWatcher, str]] = None,
    ) -> str:
        """
        Write content to a file with conflict resolution.

        Args:
            filename: Path to the file relative to repository root
            last_content: The content as last known by the client
            content: The new content to write
            source: (watcher, handle) tuple identifying the source of the write

        Returns:
            The actual content written (may differ due to merging)

        Raises:
            ValueError: If the path attempts to escape the repository
        """
        file_path = self._normalize_and_validate_path(filename)

        # Use proper open/close pattern like edit_file
        opened = False
        try:
            # Try to open the file (may not exist)
            try:
                current_content = self.open_file(filename)
                opened = True
            except FileNotFoundError:
                # File doesn't exist, create new entry
                current_content = ""

            # Intelligent conflict resolution using diff-match-patch
            if last_content == current_content:
                # No conflict - use new content directly
                new_content = content
            else:
                # Conflict detected - perform three-way merge
                new_content = self._merge_content(
                    current_content, last_content, content
                )

            # Write to disk atomically and get mtime
            mtime = self._write_file_atomic(file_path, new_content)

            # Update internal state if file was already open
            if opened:
                self.files[filename].content = new_content
                self.files[filename].mtime = mtime

        finally:
            if opened:
                self.close_file(filename)

        # Notify watchers after closing to ensure file state is consistent
        self._notify_watchers(filename, new_content, source)

        return new_content

    def edit_file(self, filename: str, edit_function: Callable[[str], str]) -> None:
        """
        Edit a file using a function that transforms its content.

        Args:
            filename: Path to the file relative to repository root
            edit_function: Function that takes current content and returns new content

        Raises:
            ValueError: If the path attempts to escape the repository
        """
        file_path = self._normalize_and_validate_path(filename)

        opened = False
        try:
            content = self.open_file(filename)
            opened = True
            new_content = edit_function(content)

            # Write to disk atomically and get mtime
            mtime = self._write_file_atomic(file_path, new_content)

            # Update internal state before closing
            self.files[filename].content = new_content
            self.files[filename].mtime = mtime

        finally:
            if opened:
                self.close_file(filename)

        # Notify watchers after closing to ensure file state is consistent
        if opened:
            self._notify_watchers(filename, new_content, None)

    def _write_file_atomic(self, file_path: Path, content: str) -> float:
        """
        Write a file atomically using a temporary file.

        Args:
            file_path: Absolute path to the file
            content: Content to write

        Returns:
            The mtime of the written file

        Raises:
            OSError: If writing fails
        """
        # Ensure parent directories exist
        file_path.parent.mkdir(parents=True, exist_ok=True)

        # Write to temporary file first
        temp_fd = None
        temp_path = None
        try:
            temp_fd, temp_path = tempfile.mkstemp(
                suffix=".tmp", prefix=f".{file_path.name}_", dir=file_path.parent
            )

            # Write content to temporary file
            with os.fdopen(temp_fd, "w", encoding="utf-8") as temp_file:
                temp_file.write(content)
                temp_file.flush()
                os.fsync(temp_file.fileno())

            temp_fd = None  # File descriptor is now closed

            # Get mtime before rename to avoid race condition
            temp_stat = os.stat(temp_path)
            mtime = temp_stat.st_mtime

            # Atomically rename to final location
            os.rename(temp_path, file_path)
            temp_path = None  # Successfully renamed

            return mtime

        except Exception:
            # Clean up on error
            if temp_fd is not None:
                try:
                    os.close(temp_fd)
                except OSError:
                    pass

            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

            raise

    def _merge_content(
        self, current_content: str, last_content: str, new_content: str
    ) -> str:
        """
        Merge content using diff-match-patch algorithm.

        Args:
            current_content: The current file content on disk
            last_content: The content as last known by the client
            new_content: The new content the client wants to write

        Returns:
            The merged content, with failed patches discarded
        """
        try:
            # Create diff-match-patch instance
            dmp = diff_match_patch()

            # Create patches representing the changes from last_content to new_content
            patches = dmp.patch_make(last_content, new_content)

            # Apply the patches to the current content
            result = dmp.patch_apply(patches, current_content)

            # result is a tuple: (merged_text, list_of_boolean_results)
            merged_text, patch_results = result

            # According to the design, we should discard failed patches gracefully
            # The diff-match-patch library already does this - it returns the best-effort result
            # We don't need to check patch_results for this implementation

            return merged_text

        except Exception:
            # If diff-match-patch fails for any reason, fall back to keeping current content
            # This ensures the system never crashes due to merge failures
            logger.exception("Content merge failed, keeping current content")
            return current_content

    def _notify_watchers(
        self,
        filename: str,
        content: str,
        source: Optional[Tuple[FileSystemWatcher, str]] = None,
    ) -> None:
        """Notify all watchers of a file change."""
        for watcher in self.watchers:
            if source is not None and watcher == source[0]:
                watcher.on_file_change(filename, content, source[1])
            else:
                watcher.on_file_change(filename, content, None)

    @asynccontextmanager
    async def watch_files(self) -> AsyncIterator[None]:
        """
        Async context manager for watching file changes and git HEAD changes.

        Usage:
            async with filesystem.watch_files():
                # File changes will be automatically detected and processed
                await some_other_work()
        """
        # Initialize HEAD tracking
        self._initialize_head_tracking()

        async def _watch_files() -> None:
            try:
                async for changes in awatch(
                    self.repository_path, recursive=True, watch_filter=None
                ):
                    for change_type, file_path_str in changes:
                        await self._handle_file_change(change_type, Path(file_path_str))
            except asyncio.CancelledError:
                # Expected when stopping the watcher
                pass

        watch_task = asyncio.create_task(_watch_files())
        try:
            # This gives _watch_files() the chance to run until the point awatch()
            # has set up the necessary inotify watches and suspends itself to wait
            # for events.
            # https://github.com/samuelcolvin/watchfiles/issues/350
            await asyncio.sleep(0)
            yield
        finally:
            watch_task.cancel()
            try:
                await watch_task
            except asyncio.CancelledError:
                pass

    async def _handle_file_change(self, change_type: Change, file_path: Path) -> None:
        """
        Handle a single file change event.

        Args:
            change_type: The type of change (added, modified, deleted)
            file_path: Absolute path to the changed file
        """
        try:
            # Convert absolute path to relative path within repository
            try:
                relative_path = file_path.relative_to(self.repository_path)
                filename = str(relative_path)
            except ValueError:
                # File is outside repository, ignore
                return

            # Handle .git directory changes for HEAD tracking
            if filename.startswith(".git/") or filename == ".git":
                # Check if this is a change to HEAD or the current ref file
                if file_path == self._git_head_file or (
                    self._current_ref_file and file_path == self._current_ref_file
                ):
                    # Check for HEAD changes
                    logger.debug(
                        "Detected change to git file %s, checking HEAD changes",
                        file_path,
                    )
                    changed = self._check_head_changes()
                    logger.debug("HEAD change check result: %s", changed)
                return

            # Only process files that are currently being tracked
            if filename not in self.files:
                return

            if change_type == Change.deleted:
                # File was deleted
                await self._handle_file_deletion(filename)
            elif change_type in (Change.added, Change.modified):
                # File was added or modified
                await self._handle_file_modification(filename, file_path)

        except Exception:
            # Log error but continue processing other changes
            logger.exception("Error handling file change for %s", file_path)

    async def _handle_file_deletion(self, filename: str) -> None:
        """
        Handle deletion of a tracked file.

        Args:
            filename: Relative path of the deleted file
        """
        if filename in self.files:
            # File was deleted externally, update our tracking
            # For now, we'll just remove it from tracking
            # In the future, this might need more sophisticated handling
            del self.files[filename]

            # Notify watchers that the file was deleted (with empty content)
            self._notify_watchers(filename, "", None)

    async def _handle_file_modification(self, filename: str, file_path: Path) -> None:
        """
        Handle modification of a tracked file.

        Args:
            filename: Relative path of the modified file
            file_path: Absolute path to the modified file
        """
        if not file_path.exists():
            # File was moved or deleted between detection and processing
            await self._handle_file_deletion(filename)
            return

        try:
            # Get current file stats
            file_stat = file_path.stat()
            current_mtime = file_stat.st_mtime

            # Check if mtime actually changed
            if filename in self.files and self.files[filename].mtime == current_mtime:
                return  # No actual change

            # Read the new content
            new_content = file_path.read_text(encoding="utf-8")

            # Update our internal state
            if filename in self.files:
                self.files[filename].content = new_content
                self.files[filename].mtime = current_mtime

                # Notify watchers of the change
                self._notify_watchers(filename, new_content, None)

        except (OSError, UnicodeDecodeError):
            # Error reading file, might be temporarily inaccessible
            logger.exception("Error reading modified file %s", filename)

    def _is_committed_file_path(self, filename: str) -> bool:
        """Check if filename uses @file syntax for committed versions."""
        return filename.startswith("@")

    def _extract_git_file_path(self, filename: str) -> str:
        """Extract the actual file path from @file syntax."""
        if not self._is_committed_file_path(filename):
            raise ValueError(f"Not a committed file path: {filename}")
        return filename[1:]  # Remove the @ prefix

    def _read_file_from_git(self, git_file_path: str, revision: str = "HEAD") -> str:
        """
        Read a file from a specific git revision.

        Args:
            git_file_path: Path to the file within the git repository
            revision: Git revision (default: HEAD)

        Returns:
            Content of the file in the specified revision

        Raises:
            FileNotFoundError: If file doesn't exist in the revision
            ValueError: If revision is invalid
        """
        try:
            result = subprocess.run(
                ["git", "cat-file", "blob", f"{revision}:{git_file_path}"],
                cwd=self.repository_path,
                capture_output=True,
                text=True,
                check=True,
            )
            return result.stdout
        except subprocess.CalledProcessError as e:
            if "does not exist" in e.stderr or "not in the working tree" in e.stderr:
                raise FileNotFoundError(f"File not found in git: @{git_file_path}")
            elif "bad revision" in e.stderr or "unknown revision" in e.stderr:
                raise ValueError(f"Invalid git revision: {revision}")
            else:
                # Re-raise with original error for unexpected cases
                raise

    def commit(self, message: str) -> None:
        """
        Commit all changes to the git repository.

        Args:
            message: Commit message

        Raises:
            RuntimeError: If git commands fail
        """
        try:
            # Stage all changes (respects .gitignore)
            subprocess.run(
                ["git", "add", "-A"],
                cwd=self.repository_path,
                check=True,
                capture_output=True,
            )

            # Create the commit
            subprocess.run(
                ["git", "commit", "-m", message],
                cwd=self.repository_path,
                check=True,
                capture_output=True,
            )

            # Notify watchers about the successful commit
            # This will be enhanced when we add HEAD change detection

        except subprocess.CalledProcessError as e:
            # Handle the case where there's nothing to commit
            if (
                "nothing to commit" in e.stdout.decode()
                or "nothing to commit" in e.stderr.decode()
            ):
                # This is not an error - just means no changes were made
                pass
            else:
                raise RuntimeError(f"Git commit failed: {e.stderr.decode()}")

    def _resolve_head_commit(self) -> tuple[str, Optional[Path]]:
        """
        Manually resolve HEAD to the actual commit hash.

        Returns:
            Tuple of (commit_hash, ref_file_to_watch) where ref_file_to_watch
            is the file that should be monitored for changes to this commit
        """
        try:
            # Read HEAD file
            head_content = self._git_head_file.read_text().strip()

            if head_content.startswith("ref: "):
                # HEAD points to a ref (branch) - read the ref file
                ref_path = head_content[5:]  # Remove "ref: " prefix
                ref_file = self.repository_path / ".git" / ref_path

                try:
                    commit_hash = ref_file.read_text().strip()
                    return commit_hash, ref_file
                except FileNotFoundError:
                    # Ref doesn't exist yet (new repository)
                    return "", ref_file
            else:
                # HEAD points directly to a commit (detached) - use HEAD content
                return head_content, self._git_head_file

        except (OSError, FileNotFoundError):
            # Git repository might be in an unusual state
            return "", self._git_head_file

    def _initialize_head_tracking(self) -> None:
        """Initialize HEAD tracking by resolving current commit."""
        try:
            self._current_head_commit, self._current_ref_file = (
                self._resolve_head_commit()
            )
        except Exception:
            logger.exception("Failed to initialize HEAD tracking")
            self._current_head_commit = None
            self._current_ref_file = None

    def _check_head_changes(self) -> bool:
        """
        Check if HEAD has changed by re-resolving and comparing.

        Returns:
            True if changes were detected and processed
        """
        try:
            new_head_commit, new_ref_file = self._resolve_head_commit()

            if new_head_commit != self._current_head_commit:
                # HEAD changed - update tracking and committed files
                self._current_head_commit = new_head_commit
                self._current_ref_file = new_ref_file

                # Update all open committed files
                self._update_committed_files()

                return True

        except Exception:
            logger.exception("Error checking HEAD changes")

        return False

    def _update_committed_files(self) -> None:
        """Update all open committed files to reflect the current HEAD."""
        committed_files = [
            filename
            for filename in self.files.keys()
            if self._is_committed_file_path(filename)
        ]

        for filename in committed_files:
            try:
                git_file_path = self._extract_git_file_path(filename)
                old_content = self.files[filename].content

                try:
                    new_content = self._read_file_from_git(git_file_path)
                except FileNotFoundError:
                    # File was deleted in the new commit
                    new_content = ""

                # Only notify watchers if content actually changed
                if new_content != old_content:
                    # Update internal state
                    self.files[filename].content = new_content

                    # Notify watchers
                    self._notify_watchers(filename, new_content, None)

            except Exception:
                logger.exception("Error updating committed file %s", filename)
