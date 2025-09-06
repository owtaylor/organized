import pytest
import tempfile
from pathlib import Path
import subprocess
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

    def __init__(self):
        self.changes = []

    def on_file_change(self, filename: str, content: str) -> None:
        self.changes.append((filename, content))


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
        """Test writing to file with conflict (simplified for now)."""
        fs = FileSystem(git_repo)

        # Open and modify file externally
        fs.open_file("test.txt")
        (git_repo / "test.txt").write_text("externally modified")

        # Try to write based on old content
        result = fs.write_file("test.txt", "initial content", "my changes")

        # For now, should just use the new content (will be improved with diff-match-patch)
        assert result == "my changes"
        assert (git_repo / "test.txt").read_text() == "my changes"

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
                ValueError, match="attempts to access files outside the repository"
            ):
                fs.open_file(path)

            with pytest.raises(
                ValueError, match="attempts to access files outside the repository"
            ):
                fs.write_file(path, "", "malicious content")

            with pytest.raises(
                ValueError, match="attempts to access files outside the repository"
            ):
                fs.edit_file(path, lambda x: "malicious")

    def test_path_normalization_within_repo(self, git_repo):
        """Test that valid relative paths are normalized correctly."""
        fs = FileSystem(git_repo)

        # Create a subdirectory and file
        (git_repo / "subdir").mkdir()
        (git_repo / "subdir" / "file.txt").write_text("test content")

        # Test that normalization works for reading existing files
        content = fs.open_file("subdir/file.txt")
        assert content == "test content"
        fs.close_file("subdir/file.txt")

        # Test that normalized path works for writing
        fs.write_file("subdir/../new_file.txt", "", "new content")
        assert (git_repo / "new_file.txt").read_text() == "new content"

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
