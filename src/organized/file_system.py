"""
FileSystem module for managing file operations with git integration.

This module implements a filesystem abstraction layer that provides
real-time file synchronization, conflict resolution, and git integration
as specified in FILESYSTEM_DESIGN.md.
"""

import abc
import asyncio
import os
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Callable, AsyncIterator

from watchfiles import awatch, Change


@dataclass
class File:
    """Represents a file with its current state."""

    content: str
    ref_count: int = 0
    mtime: float = 0.0


class FileSystemWatcher(abc.ABC):
    """Abstract base class for objects that watch file system changes."""

    @abc.abstractmethod
    def on_file_change(self, filename: str, content: str) -> None:
        """Called when a file changes."""
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

    def _normalize_and_validate_path(self, filename: str) -> Path:
        """
        Normalize and validate a file path to prevent directory traversal.

        Args:
            filename: The input filename/path

        Returns:
            Absolute Path object within the repository

        Raises:
            ValueError: If the path attempts to escape the repository
        """
        # Convert to Path object and resolve any . and .. components
        path = Path(filename)

        # Convert to absolute path within repository context
        absolute_path = (self.repository_path / path).resolve()

        # Check if the resolved path is within the repository
        try:
            # This will raise ValueError if absolute_path is not within repository_path
            absolute_path.relative_to(self.repository_path)
            return absolute_path

        except ValueError:
            raise ValueError(
                f"Path '{filename}' attempts to access files outside the repository"
            )

    def open_file(self, filename: str) -> str:
        """
        Open a file and increment its reference count.

        Args:
            filename: Path to the file relative to repository root

        Returns:
            Current content of the file

        Raises:
            FileNotFoundError: If the file doesn't exist
            ValueError: If the path attempts to escape the repository
        """
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
        exclude_watcher: Optional[FileSystemWatcher] = None,
    ) -> str:
        """
        Write content to a file with conflict resolution.

        Args:
            filename: Path to the file relative to repository root
            last_content: The content as last known by the client
            content: The new content to write
            exclude_watcher: Watcher to exclude from notifications

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

            # Simple conflict resolution: if last_content matches current, use new content
            # Otherwise, keep current content (will be improved with diff-match-patch)
            if last_content == current_content:
                new_content = content
            else:
                # For now, just use the new content - this will be improved
                new_content = content

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
        self._notify_watchers(filename, new_content, exclude_watcher)

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
            self._notify_watchers(filename, new_content)

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

    def _notify_watchers(
        self,
        filename: str,
        content: str,
        exclude_watcher: Optional[FileSystemWatcher] = None,
    ) -> None:
        """Notify all watchers of a file change."""
        for watcher in self.watchers:
            if watcher != exclude_watcher:
                watcher.on_file_change(filename, content)

    @asynccontextmanager
    async def watch_files(self) -> AsyncIterator[None]:
        """
        Async context manager for watching file changes.

        Usage:
            async with filesystem.watch_files():
                # File changes will be automatically detected and processed
                await some_other_work()
        """

        async def _watch_files() -> None:
            try:
                async for changes in awatch(self.repository_path):
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

            # Skip .git directory changes
            if filename.startswith(".git/") or filename == ".git":
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

        except Exception as e:
            # Log error but continue processing other changes
            print(f"Error handling file change for {file_path}: {e}")

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
            self._notify_watchers(filename, "")

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
                self._notify_watchers(filename, new_content)

        except (OSError, UnicodeDecodeError) as e:
            # Error reading file, might be temporarily inaccessible
            print(f"Error reading modified file {filename}: {e}")
