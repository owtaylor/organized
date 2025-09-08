import pytest
import tempfile
from pathlib import Path
import subprocess
import asyncio
from unittest.mock import patch

from src.organized.file_system import FileSystem, FileSystemWatcher


@pytest.fixture
def git_repo():
    """Create a temporary git repository for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        repo_path = Path(temp_dir)

        # Initialize git repo
        subprocess.run(["git", "init"], cwd=repo_path, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=repo_path,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=repo_path, check=True
        )

        # Create initial commit
        test_file = repo_path / "test.txt"
        test_file.write_text("initial content")
        subprocess.run(["git", "add", "test.txt"], cwd=repo_path, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Initial commit"], cwd=repo_path, check=True
        )

        yield repo_path


class MockWatcher(FileSystemWatcher):
    """Mock watcher for testing."""

    WAIT_TIMEOUT = 1.0  # 1 second timeout for wait operations

    def __init__(self):
        self.changes = []
        self._condition = asyncio.Condition()

    def on_file_change(self, filename: str, content: str) -> None:
        # Always add the change to the list synchronously
        self.changes.append((filename, content))

        # Try to notify async waiters if there's an event loop
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # No event loop running, which is fine for sync tests
            return

        async def notify():
            async with self._condition:
                self._condition.notify_all()

        # Schedule the async notification
        asyncio.create_task(notify())

    async def wait_for(self, predicate, timeout: float = WAIT_TIMEOUT) -> bool:
        """
        Wait for a change that matches the given predicate.

        Args:
            predicate: Function that takes a (filename, content) tuple and returns bool
            timeout: Maximum time to wait in seconds

        Returns:
            True if matching change was found, False if timeout
        """
        async with self._condition:
            try:
                await asyncio.wait_for(
                    self._condition.wait_for(
                        lambda: any(predicate(change) for change in self.changes)
                    ),
                    timeout=timeout,
                )
                return True
            except asyncio.TimeoutError:
                return False

    async def wait_for_change_count(
        self, count: int, timeout: float = WAIT_TIMEOUT
    ) -> bool:
        """Wait until we have at least 'count' changes."""
        async with self._condition:
            try:
                await asyncio.wait_for(
                    self._condition.wait_for(lambda: len(self.changes) >= count),
                    timeout=timeout,
                )
                return True
            except asyncio.TimeoutError:
                return False


class TestFileSystem:
    def test_init(self, git_repo):
        """Test FileSystem initialization with a git repository."""
        fs = FileSystem(git_repo)
        assert fs.repository_path == git_repo
        assert fs.files == {}
        assert fs.watchers == []

    def test_repository_path_validation(self):
        """Test that FileSystem validates the repository path."""
        with pytest.raises(ValueError, match="Repository path does not exist"):
            FileSystem(Path("/nonexistent/path"))

    def test_git_repository_validation(self, git_repo):
        """Test that FileSystem validates git repository."""
        # Remove .git directory to make it not a git repo
        subprocess.run(["rm", "-rf", ".git"], cwd=git_repo, check=True)

        with pytest.raises(ValueError, match="Path is not a git repository"):
            FileSystem(git_repo)

    def test_open_existing_file(self, git_repo):
        """Test opening an existing file."""
        fs = FileSystem(git_repo)
        content = fs.open_file("test.txt")

        assert content == "initial content"
        assert "test.txt" in fs.files
        assert fs.files["test.txt"].ref_count == 1
        assert fs.files["test.txt"].content == "initial content"

    def test_open_nonexistent_file(self, git_repo):
        """Test opening a file that doesn't exist."""
        fs = FileSystem(git_repo)

        with pytest.raises(FileNotFoundError, match="File not found: nonexistent.txt"):
            fs.open_file("nonexistent.txt")

    def test_open_file_multiple_times(self, git_repo):
        """Test opening the same file multiple times increments ref count."""
        fs = FileSystem(git_repo)

        content1 = fs.open_file("test.txt")
        content2 = fs.open_file("test.txt")

        assert content1 == content2 == "initial content"
        assert fs.files["test.txt"].ref_count == 2

    def test_close_file(self, git_repo):
        """Test closing a file decrements ref count."""
        fs = FileSystem(git_repo)

        fs.open_file("test.txt")
        fs.open_file("test.txt")
        assert fs.files["test.txt"].ref_count == 2

        fs.close_file("test.txt")
        assert fs.files["test.txt"].ref_count == 1
        assert "test.txt" in fs.files

        fs.close_file("test.txt")
        assert "test.txt" not in fs.files

    def test_close_unopened_file(self, git_repo):
        """Test closing a file that wasn't opened doesn't crash."""
        fs = FileSystem(git_repo)
        fs.close_file("nonexistent.txt")  # Should not raise

    def test_watcher_management(self, git_repo):
        """Test adding and removing watchers."""
        fs = FileSystem(git_repo)
        watcher1 = MockWatcher()
        watcher2 = MockWatcher()

        fs.add_watcher(watcher1)
        fs.add_watcher(watcher2)
        assert len(fs.watchers) == 2

        fs.remove_watcher(watcher1)
        assert len(fs.watchers) == 1
        assert watcher2 in fs.watchers

        # Remove non-existent watcher
        fs.remove_watcher(watcher1)  # Should not raise
        assert len(fs.watchers) == 1

    def test_write_file_new_file(self, git_repo):
        """Test writing to a new file."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        result = fs.write_file("new.txt", "", "hello world")

        assert result == "hello world"
        assert (git_repo / "new.txt").read_text() == "hello world"
        # New files are not kept in fs.files since they weren't opened
        assert "new.txt" not in fs.files
        assert len(watcher.changes) == 1
        assert watcher.changes[0] == ("new.txt", "hello world")

    def test_write_file_existing_file_no_conflict(self, git_repo):
        """Test writing to existing file with no conflict."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Open the file first
        fs.open_file("test.txt")
        original_content = "initial content"
        new_content = "updated content"

        result = fs.write_file("test.txt", original_content, new_content)

        assert result == new_content
        assert (git_repo / "test.txt").read_text() == new_content
        assert fs.files["test.txt"].content == new_content
        assert len(watcher.changes) == 1
        assert watcher.changes[0] == ("test.txt", new_content)

    def test_write_file_with_conflict(self, git_repo):
        """Test writing to file with conflict using diff-match-patch merging."""
        fs = FileSystem(git_repo)

        # Open and modify file externally
        fs.open_file("test.txt")
        (git_repo / "test.txt").write_text("externally modified")
        fs.files["test.txt"].content = "externally modified"  # Simulate external update

        # Try to write based on old content
        result = fs.write_file("test.txt", "initial content", "my changes")

        # With diff-match-patch, the patch from "initial content" to "my changes"
        # will likely fail to apply to "externally modified", so current content is kept
        assert result == "externally modified"
        assert (git_repo / "test.txt").read_text() == "externally modified"

    def test_write_file_exclude_watcher(self, git_repo):
        """Test that excluded watcher doesn't get notified."""
        fs = FileSystem(git_repo)
        watcher1 = MockWatcher()
        watcher2 = MockWatcher()
        fs.add_watcher(watcher1)
        fs.add_watcher(watcher2)

        fs.write_file("new.txt", "", "content", exclude_watcher=watcher1)

        assert len(watcher1.changes) == 0
        assert len(watcher2.changes) == 1

    def test_edit_file(self, git_repo):
        """Test editing a file with a function."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        def uppercase_content(content):
            return content.upper()

        fs.edit_file("test.txt", uppercase_content)

        assert (git_repo / "test.txt").read_text() == "INITIAL CONTENT"
        # edit_file doesn't keep the file open, so it won't be in fs.files
        assert "test.txt" not in fs.files
        assert len(watcher.changes) == 1
        assert watcher.changes[0] == ("test.txt", "INITIAL CONTENT")

    def test_edit_file_with_subdirectory(self, git_repo):
        """Test editing a file in a subdirectory (creates parent dirs)."""
        fs = FileSystem(git_repo)

        # Create a file in subdirectory
        (git_repo / "subdir").mkdir()
        (git_repo / "subdir" / "file.txt").write_text("test content")

        def add_suffix(content):
            return content + " modified"

        fs.edit_file("subdir/file.txt", add_suffix)

        assert (git_repo / "subdir" / "file.txt").read_text() == "test content modified"

    def test_atomic_write_cleanup_on_rename_error(self, git_repo):
        """Test that temporary files are cleaned up when rename fails."""
        fs = FileSystem(git_repo)

        with patch("os.rename", side_effect=OSError("Rename failed")):
            with pytest.raises(OSError, match="Rename failed"):
                fs.write_file("test_file.txt", "", "content")

            # Check no temp files are left behind
            temp_files = list(git_repo.glob(".*tmp*"))
            assert len(temp_files) == 0

    def test_path_traversal_protection(self, git_repo):
        """Test that path traversal attempts are blocked."""
        fs = FileSystem(git_repo)

        # Test various path traversal attempts
        dangerous_paths = [
            "../../../etc/passwd",
            "../../root/.ssh/id_rsa",
            "/etc/passwd",
            "subdir/../../etc/passwd",
            "foo/../../../etc/passwd",
        ]

        for path in dangerous_paths:
            with pytest.raises(
                ValueError,
                match="contains '.' or '..' components|is not normalized|must be relative to repository root",
            ):
                fs.open_file(path)

            with pytest.raises(
                ValueError,
                match="contains '.' or '..' components|is not normalized|must be relative to repository root",
            ):
                fs.write_file(path, "", "malicious content")

            with pytest.raises(
                ValueError,
                match="contains '.' or '..' components|is not normalized|must be relative to repository root",
            ):
                fs.edit_file(path, lambda x: "malicious")

    def test_path_validation_requires_normalized_paths(self, git_repo):
        """Test that path validation requires already-normalized paths."""
        fs = FileSystem(git_repo)

        # Test that unnormalized paths are rejected
        with pytest.raises(ValueError, match="is not normalized"):
            fs.open_file("subdir/../file.txt")

        with pytest.raises(ValueError, match="is not normalized"):
            fs.write_file("subdir/../new_file.txt", "", "new content")

    def test_write_file_new_file_no_ref_leak(self, git_repo):
        """Test that write_file doesn't leave refcount=0 entries for new files."""
        fs = FileSystem(git_repo)

        # Write to a new file
        result = fs.write_file("brand_new.txt", "", "new file content")
        assert result == "new file content"
        assert (git_repo / "brand_new.txt").read_text() == "new file content"

        # The file should NOT be in fs.files since it wasn't opened
        assert "brand_new.txt" not in fs.files

    def test_write_file_existing_file_proper_refcount(self, git_repo):
        """Test that write_file properly handles refcounts for existing files."""
        fs = FileSystem(git_repo)

        # Open the file first so it's tracked
        original_content = fs.open_file("test.txt")
        assert fs.files["test.txt"].ref_count == 1

        # Write to it - should maintain proper refcount handling
        result = fs.write_file("test.txt", original_content, "updated content")
        assert result == "updated content"
        assert (git_repo / "test.txt").read_text() == "updated content"

        # File should still be tracked with same refcount
        assert fs.files["test.txt"].ref_count == 1
        assert fs.files["test.txt"].content == "updated content"

        # Close properly
        fs.close_file("test.txt")
        assert "test.txt" not in fs.files


class TestContentMerging:
    """Test cases for content merging functionality using diff-match-patch."""

    def test_merge_no_conflict_same_content(self, git_repo):
        """Test merging when last_content equals current_content (no conflict)."""
        fs = FileSystem(git_repo)

        # Open file and get current content
        current_content = fs.open_file("test.txt")
        assert current_content == "initial content"

        # Write with same last_content - should work normally
        result = fs.write_file("test.txt", current_content, "updated content")

        assert result == "updated content"
        assert (git_repo / "test.txt").read_text() == "updated content"
        assert fs.files["test.txt"].content == "updated content"

    def test_merge_simple_non_conflicting_changes(self, git_repo):
        """Test merging non-conflicting changes to different parts of file."""
        fs = FileSystem(git_repo)

        # Set up initial content
        initial_content = "Line 1\nLine 2\nLine 3"
        (git_repo / "test.txt").write_text(initial_content)

        # Open file
        fs.open_file("test.txt")

        # Simulate external change to line 1
        current_content = "Modified Line 1\nLine 2\nLine 3"
        (git_repo / "test.txt").write_text(current_content)
        fs.files["test.txt"].content = current_content  # Simulate external update

        # Client wants to change line 3 based on original content
        client_content = "Line 1\nLine 2\nModified Line 3"

        result = fs.write_file("test.txt", initial_content, client_content)

        # Should merge both changes
        expected_merged = "Modified Line 1\nLine 2\nModified Line 3"
        assert result == expected_merged
        assert (git_repo / "test.txt").read_text() == expected_merged

    def test_merge_conflicting_changes_same_line(self, git_repo):
        """Test merging when both client and external changes modify the same line."""
        fs = FileSystem(git_repo)

        initial_content = "The quick brown fox"
        (git_repo / "test.txt").write_text(initial_content)
        fs.open_file("test.txt")

        # External change
        current_content = "The quick red fox"
        (git_repo / "test.txt").write_text(current_content)
        fs.files["test.txt"].content = current_content

        # Client change to same part
        client_content = "The quick blue fox"

        result = fs.write_file("test.txt", initial_content, client_content)

        # diff-match-patch applies the client's change (blue) to the current content (red)
        # Result: applies "b" -> "bl" change, turning "red" into "lue"
        # TODO: investigate word-mode diffs to avoid this weird character-level behavior
        expected_result = "The quick lue fox"
        assert result == expected_result
        assert (git_repo / "test.txt").read_text() == expected_result

    def test_merge_addition_and_deletion(self, git_repo):
        """Test merging when one side adds content and another deletes."""
        fs = FileSystem(git_repo)

        initial_content = "Line 1\nLine 2\nLine 3\nLine 4"
        (git_repo / "test.txt").write_text(initial_content)
        fs.open_file("test.txt")

        # External change: delete line 2
        current_content = "Line 1\nLine 3\nLine 4"
        (git_repo / "test.txt").write_text(current_content)
        fs.files["test.txt"].content = current_content

        # Client change: add a new line after line 3
        client_content = "Line 1\nLine 2\nLine 3\nNew Line\nLine 4"

        result = fs.write_file("test.txt", initial_content, client_content)

        # Should apply both changes where possible
        expected_result = "Line 1\nLine 3\nNew Line\nLine 4"
        assert result == expected_result
        assert (git_repo / "test.txt").read_text() == expected_result

    def test_merge_empty_file_to_content(self, git_repo):
        """Test merging when starting with empty file."""
        fs = FileSystem(git_repo)

        # Create empty file
        (git_repo / "empty.txt").write_text("")
        fs.open_file("empty.txt")

        # Client adds content
        result = fs.write_file("empty.txt", "", "New content")

        assert result == "New content"
        assert (git_repo / "empty.txt").read_text() == "New content"

    def test_merge_content_to_empty_file(self, git_repo):
        """Test merging when file becomes empty externally."""
        fs = FileSystem(git_repo)

        initial_content = "Some content"
        (git_repo / "test.txt").write_text(initial_content)
        fs.open_file("test.txt")

        # External change: file becomes empty
        (git_repo / "test.txt").write_text("")
        fs.files["test.txt"].content = ""

        # Client tries to modify based on original content
        client_content = "Some modified content"

        result = fs.write_file("test.txt", initial_content, client_content)

        # Patch will likely fail to apply, so should keep current (empty) content
        expected_result = ""
        assert result == expected_result
        assert (git_repo / "test.txt").read_text() == expected_result

    def test_merge_patch_failure_handling(self, git_repo):
        """Test that patch failures are handled gracefully by discarding failed changes."""
        fs = FileSystem(git_repo)

        # Create a scenario where patches will definitely fail
        initial_content = "A\nB\nC"
        (git_repo / "test.txt").write_text(initial_content)
        fs.open_file("test.txt")

        # External change: completely different content
        current_content = "X\nY\nZ\nW"
        (git_repo / "test.txt").write_text(current_content)
        fs.files["test.txt"].content = current_content

        # Client change based on original
        client_content = "A\nB modified\nC"

        result = fs.write_file("test.txt", initial_content, client_content)

        # Patches should fail to apply, so should keep current content unchanged
        expected_result = "X\nY\nZ\nW"
        assert result == expected_result
        assert (git_repo / "test.txt").read_text() == expected_result

    def test_merge_preserves_file_encoding(self, git_repo):
        """Test that merging preserves UTF-8 encoding."""
        fs = FileSystem(git_repo)

        # Content with unicode characters
        initial_content = "Hello 世界\nLine 2"
        (git_repo / "test.txt").write_text(initial_content, encoding="utf-8")
        fs.open_file("test.txt")

        # External change
        current_content = "Hello 世界\nModified Line 2"
        (git_repo / "test.txt").write_text(current_content, encoding="utf-8")
        fs.files["test.txt"].content = current_content

        # Client change
        client_content = "Hello 世界 updated\nLine 2"

        result = fs.write_file("test.txt", initial_content, client_content)

        # Should merge to: external change to line 2, client change to line 1
        expected_result = "Hello 世界 updated\nModified Line 2"
        assert result == expected_result
        assert (git_repo / "test.txt").read_text() == expected_result


class TestFileSystemWatching:
    """Test cases for file system watching functionality."""

    @pytest.mark.asyncio
    async def test_watch_files_context_manager(self, git_repo):
        """Test that watch_files context manager works correctly."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Open a file to track it
        fs.open_file("test.txt")

        async with fs.watch_files():
            # Modify the file externally
            (git_repo / "test.txt").write_text("externally modified content")

            # Wait for the change to be detected
            found = await watcher.wait_for(
                lambda c: c[0] == "test.txt" and "externally modified content" in c[1],
                timeout=5.0,
            )
            assert found, "File change was not detected within timeout"

    @pytest.mark.asyncio
    async def test_watch_files_ignores_untracked_files(self, git_repo):
        """Test that file watcher ignores changes to untracked files."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        async with fs.watch_files():
            # Create and modify a file that isn't being tracked
            untracked_file = git_repo / "untracked.txt"
            untracked_file.write_text("untracked content")

            # Wait a short time to see if any changes are detected
            found = await watcher.wait_for_change_count(1, timeout=0.2)

        # Should not have detected any changes since file wasn't tracked
        assert not found, "Untracked file changes should be ignored"
        assert len(watcher.changes) == 0

    @pytest.mark.asyncio
    async def test_watch_files_handles_file_deletion(self, git_repo):
        """Test that file watcher handles file deletion correctly."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Open a file to track it
        fs.open_file("test.txt")

        async with fs.watch_files():
            # Delete the file externally
            (git_repo / "test.txt").unlink()

            # Wait for deletion to be detected (notified with empty content)
            found = await watcher.wait_for(lambda c: c[0] == "test.txt" and c[1] == "")
            assert found, "File deletion was not detected"

        # Check that deletion was handled properly
        assert "test.txt" not in fs.files

    @pytest.mark.asyncio
    async def test_watch_files_updates_internal_state(self, git_repo):
        """Test that file watcher updates internal FileSystem state."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Open and track a file
        original_content = fs.open_file("test.txt")
        assert fs.files["test.txt"].content == original_content

        async with fs.watch_files():
            # Modify the file externally
            new_content = "modified by external process"
            (git_repo / "test.txt").write_text(new_content)

            # Wait for change detection
            found = await watcher.wait_for(
                lambda c: c[0] == "test.txt" and new_content in c[1]
            )
            assert found, "File modification was not detected"

        # Internal state should be updated
        assert fs.files["test.txt"].content == new_content

    @pytest.mark.asyncio
    async def test_watch_files_ignores_git_directory(self, git_repo):
        """Test that file watcher ignores changes in .git directory."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        async with fs.watch_files():
            # Create a file in .git directory
            git_file = git_repo / ".git" / "test_file"
            git_file.write_text("git internal content")

            # Wait briefly to see if change is detected
            found = await watcher.wait_for_change_count(1, timeout=0.2)

        # Should not have detected the change
        assert not found, "Changes in .git directory should be ignored"
        assert len(watcher.changes) == 0

    @pytest.mark.asyncio
    async def test_watch_files_handles_multiple_files(self, git_repo):
        """Test watching multiple files simultaneously."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Create and open multiple files
        file2 = git_repo / "file2.txt"
        file2.write_text("file2 content")
        file3 = git_repo / "file3.txt"
        file3.write_text("file3 content")

        fs.open_file("test.txt")
        fs.open_file("file2.txt")
        fs.open_file("file3.txt")

        async with fs.watch_files():
            # Modify all files
            (git_repo / "test.txt").write_text("test modified")
            (git_repo / "file2.txt").write_text("file2 modified")
            (git_repo / "file3.txt").write_text("file3 modified")

            # Wait for all changes to be detected
            found = await watcher.wait_for_change_count(3)
            assert found, "Not all file changes were detected"

        # Should have detected changes to all tracked files
        modified_files = {change[0] for change in watcher.changes}
        assert "test.txt" in modified_files
        assert "file2.txt" in modified_files
        assert "file3.txt" in modified_files

    @pytest.mark.asyncio
    async def test_watch_files_handles_subdirectory_files(self, git_repo):
        """Test watching files in subdirectories."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Create subdirectory and file
        subdir = git_repo / "subdir"
        subdir.mkdir()
        subfile = subdir / "subfile.txt"
        subfile.write_text("subfile content")

        # Track the file
        fs.open_file("subdir/subfile.txt")

        async with fs.watch_files():
            # Modify the subdirectory file
            subfile.write_text("subfile modified")

            # Wait for change detection
            found = await watcher.wait_for(
                lambda c: c[0] == "subdir/subfile.txt" and "subfile modified" in c[1]
            )
            assert found, "Subdirectory file change was not detected"

    @pytest.mark.asyncio
    async def test_watch_files_exception_handling(self, git_repo):
        """Test that exceptions in file processing don't crash the watcher."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Track a file
        fs.open_file("test.txt")

        async with fs.watch_files():
            # Create a file and track it, then delete it immediately (race condition)
            temp_file = git_repo / "temp.txt"
            temp_file.write_text("temp content")
            fs.open_file("temp.txt")
            temp_file.unlink()

            # Modify the original tracked file to ensure watcher is still working
            (git_repo / "test.txt").write_text("still working after exception")

            # Wait for the test.txt change to be detected
            found = await watcher.wait_for(
                lambda c: c[0] == "test.txt" and "still working" in c[1]
            )
            assert found, "Watcher should still work after handling exceptions"


class TestGitIntegration:
    """Test cases for Git integration functionality."""

    def test_open_committed_file_basic(self, git_repo):
        """Test opening a committed file using @file syntax."""
        fs = FileSystem(git_repo)

        # Open committed version of test.txt (should have "initial content")
        content = fs.open_file("@test.txt")
        assert content == "initial content"
        assert "@test.txt" in fs.files
        assert fs.files["@test.txt"].ref_count == 1

    def test_open_committed_file_vs_working_copy(self, git_repo):
        """Test that @file returns committed version, not working directory version."""
        fs = FileSystem(git_repo)

        # Modify working copy
        (git_repo / "test.txt").write_text("modified in working directory")

        # Working copy should show modified content
        working_content = fs.open_file("test.txt")
        assert working_content == "modified in working directory"

        # Committed version should still show original content
        committed_content = fs.open_file("@test.txt")
        assert committed_content == "initial content"

        # Both should be tracked separately
        assert "test.txt" in fs.files
        assert "@test.txt" in fs.files

    def test_open_nonexistent_committed_file(self, git_repo):
        """Test opening a committed file that doesn't exist in the repository."""
        fs = FileSystem(git_repo)

        with pytest.raises(
            FileNotFoundError, match="File not found in git: @nonexistent.txt"
        ):
            fs.open_file("@nonexistent.txt")

    def test_open_committed_file_reference_counting(self, git_repo):
        """Test reference counting works for committed files."""
        fs = FileSystem(git_repo)

        # Open same committed file multiple times
        content1 = fs.open_file("@test.txt")
        content2 = fs.open_file("@test.txt")

        assert content1 == content2 == "initial content"
        assert fs.files["@test.txt"].ref_count == 2

        # Close and verify ref counting
        fs.close_file("@test.txt")
        assert fs.files["@test.txt"].ref_count == 1
        assert "@test.txt" in fs.files

        fs.close_file("@test.txt")
        assert "@test.txt" not in fs.files

    def test_committed_file_path_validation(self, git_repo):
        """Test path validation works for committed files."""
        fs = FileSystem(git_repo)

        # Test path traversal protection for committed files
        with pytest.raises(ValueError, match="contains '.' or '..' components"):
            fs.open_file("@../../../etc/passwd")

    def test_open_committed_file_after_new_commit(self, git_repo):
        """Test that @file reflects latest commit after new commits are made."""
        fs = FileSystem(git_repo)

        # Open committed version (original content)
        content1 = fs.open_file("@test.txt")
        assert content1 == "initial content"
        fs.close_file("@test.txt")

        # Make a new commit
        (git_repo / "test.txt").write_text("updated content")
        subprocess.run(["git", "add", "test.txt"], cwd=git_repo, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Update test.txt"], cwd=git_repo, check=True
        )

        # Opening committed version again should show new content
        content2 = fs.open_file("@test.txt")
        assert content2 == "updated content"


class TestGitCommit:
    """Test cases for git commit functionality."""

    def test_commit_basic(self, git_repo):
        """Test basic commit functionality."""
        fs = FileSystem(git_repo)

        # Create and modify some files
        (git_repo / "new_file.txt").write_text("new file content")
        (git_repo / "test.txt").write_text("modified content")

        # Commit changes
        fs.commit("Add new file and modify existing file")

        # Verify commit was created
        result = subprocess.run(
            ["git", "log", "--oneline", "-1"],
            cwd=git_repo,
            capture_output=True,
            text=True,
            check=True,
        )
        assert "Add new file and modify existing file" in result.stdout

    def test_commit_with_staged_files(self, git_repo):
        """Test commit includes properly staged files."""
        fs = FileSystem(git_repo)

        # Create new files
        (git_repo / "file1.txt").write_text("content 1")
        (git_repo / "file2.txt").write_text("content 2")

        # Commit should stage and commit all changes
        fs.commit("Add two new files")

        # Verify both files are in the commit
        result = subprocess.run(
            ["git", "show", "--name-only", "HEAD"],
            cwd=git_repo,
            capture_output=True,
            text=True,
            check=True,
        )
        assert "file1.txt" in result.stdout
        assert "file2.txt" in result.stdout

    def test_commit_empty_repository_state(self, git_repo):
        """Test commit when there are no changes to stage."""
        fs = FileSystem(git_repo)

        # Try to commit with no changes
        # This should either succeed (empty commit) or raise appropriate error
        fs.commit("Empty commit")

        # Verify no error occurred and HEAD didn't change unexpectedly
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=git_repo,
            capture_output=True,
            text=True,
            check=True,
        )
        # Should be clean (no unstaged changes)
        assert result.stdout.strip() == ""

    def test_commit_respects_gitignore(self, git_repo):
        """Test that commit respects .gitignore patterns."""
        fs = FileSystem(git_repo)

        # Create .gitignore
        (git_repo / ".gitignore").write_text("*.tmp\nignored/\n")

        # Create ignored and non-ignored files
        (git_repo / "tracked_file.txt").write_text("tracked content")
        (git_repo / "ignored_file.tmp").write_text("ignored content")
        (git_repo / "ignored").mkdir()
        (git_repo / "ignored" / "file.txt").write_text("ignored content")

        # Commit changes
        fs.commit("Add files with gitignore test")

        # Verify only non-ignored files were committed
        result = subprocess.run(
            ["git", "show", "--name-only", "HEAD"],
            cwd=git_repo,
            capture_output=True,
            text=True,
            check=True,
        )
        assert "tracked_file.txt" in result.stdout
        assert ".gitignore" in result.stdout
        assert "ignored_file.tmp" not in result.stdout
        assert "ignored/file.txt" not in result.stdout


class TestHEADChangeDetection:
    """Test cases for HEAD change detection and notifications."""

    @pytest.mark.asyncio
    async def test_head_change_detection_basic(self, git_repo):
        """Test basic HEAD change detection."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Open a committed file to track
        fs.open_file("@test.txt")

        async with fs.watch_files():
            # Make a new commit (this changes HEAD)
            (git_repo / "test.txt").write_text("new committed content")

            subprocess.run(["git", "add", "test.txt"], cwd=git_repo, check=True)
            subprocess.run(
                ["git", "commit", "-m", "Update test.txt"], cwd=git_repo, check=True
            )

            # Wait for HEAD change to be detected and @file to be updated
            found = await watcher.wait_for(
                lambda c: c[0] == "@test.txt" and "new committed content" in c[1]
            )
            assert found, "HEAD change and @file update was not detected"

    @pytest.mark.asyncio
    async def test_head_change_updates_multiple_committed_files(self, git_repo):
        """Test that HEAD changes update all open committed files."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Create another file and commit it
        (git_repo / "file2.txt").write_text("file2 initial")
        subprocess.run(["git", "add", "file2.txt"], cwd=git_repo, check=True)
        subprocess.run(["git", "commit", "-m", "Add file2"], cwd=git_repo, check=True)

        # Open both committed files
        fs.open_file("@test.txt")
        fs.open_file("@file2.txt")

        async with fs.watch_files():
            # Modify both files and commit
            (git_repo / "test.txt").write_text("test updated")
            (git_repo / "file2.txt").write_text("file2 updated")
            subprocess.run(["git", "add", "-A"], cwd=git_repo, check=True)
            subprocess.run(
                ["git", "commit", "-m", "Update both files"], cwd=git_repo, check=True
            )

            # Wait for both files to be updated
            found_test = await watcher.wait_for(
                lambda c: c[0] == "@test.txt" and "test updated" in c[1]
            )
            found_file2 = await watcher.wait_for(
                lambda c: c[0] == "@file2.txt" and "file2 updated" in c[1]
            )

            assert found_test, "@test.txt was not updated after HEAD change"
            assert found_file2, "@file2.txt was not updated after HEAD change"

    @pytest.mark.asyncio
    async def test_head_change_ignores_non_committed_files(self, git_repo):
        """Test that HEAD changes don't affect non-committed files."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Open both working directory and committed versions
        fs.open_file("test.txt")
        fs.open_file("@test.txt")

        # Make the file content change outside watch context
        (git_repo / "test.txt").write_text("updated content")
        subprocess.run(["git", "add", "test.txt"], cwd=git_repo, check=True)

        async with fs.watch_files():
            # Commit the already-staged changes (this only changes git internals, not working files)
            subprocess.run(
                ["git", "commit", "-m", "Update test.txt"], cwd=git_repo, check=True
            )

            # Wait for @test.txt to be updated
            found_committed = await watcher.wait_for(
                lambda c: c[0] == "@test.txt" and "updated content" in c[1]
            )
            assert found_committed, "@test.txt should be updated"

            # Wait with short timeout to ensure working directory file is NOT notified of HEAD changes
            found_working = await watcher.wait_for(
                lambda c: c[0] == "test.txt" and "updated content" in c[1], timeout=0.3
            )
            assert not found_working, (
                "Working directory file should not be notified of HEAD changes"
            )

    @pytest.mark.asyncio
    async def test_head_change_handles_file_deletion_in_commit(self, git_repo):
        """Test HEAD change handling when files are deleted in commits."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Create and commit a new file
        (git_repo / "temp_file.txt").write_text("temporary content")
        subprocess.run(["git", "add", "temp_file.txt"], cwd=git_repo, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Add temp file"], cwd=git_repo, check=True
        )

        # Open the committed version
        fs.open_file("@temp_file.txt")

        async with fs.watch_files():
            # Delete the file and commit the deletion
            (git_repo / "temp_file.txt").unlink()
            subprocess.run(["git", "add", "-A"], cwd=git_repo, check=True)
            subprocess.run(
                ["git", "commit", "-m", "Delete temp file"], cwd=git_repo, check=True
            )

            # The committed file should be notified with empty content or removed
            found = await watcher.wait_for(
                lambda c: c[0] == "@temp_file.txt" and c[1] == ""
            )
            assert found, "Deleted committed file should be notified with empty content"

    @pytest.mark.asyncio
    async def test_branch_change_detection(self, git_repo):
        """Test detection of branch changes (when .git/HEAD points to different ref)."""
        fs = FileSystem(git_repo)
        watcher = MockWatcher()
        fs.add_watcher(watcher)

        # Create a new branch with different content
        subprocess.run(["git", "checkout", "-b", "feature"], cwd=git_repo, check=True)
        (git_repo / "test.txt").write_text("feature branch content")
        subprocess.run(["git", "add", "test.txt"], cwd=git_repo, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Feature branch commit"], cwd=git_repo, check=True
        )

        # Go back to main branch
        subprocess.run(["git", "checkout", "main"], cwd=git_repo, check=True)

        # Open committed file on main branch
        fs.open_file("@test.txt")

        async with fs.watch_files():
            # Switch to feature branch (this changes .git/HEAD to point to different ref)
            subprocess.run(["git", "checkout", "feature"], cwd=git_repo, check=True)

            # Wait for @file to be updated with feature branch content
            found = await watcher.wait_for(
                lambda c: c[0] == "@test.txt" and "feature branch content" in c[1]
            )
            assert found, "Branch change should update committed file content"
