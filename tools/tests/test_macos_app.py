import os
import shlex
from pathlib import Path
import subprocess
import tempfile
import unittest


class MacOSAppRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aqt-macos-runner-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.app_dir = self.root / "project with spaces"
        self.app_dir.mkdir()
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.env = dict(os.environ, PATH=f"{self.bin_dir}:{os.environ['PATH']}")
        self.script = Path(__file__).resolve().parents[1] / "macos-app.sh"
        self.mock("xcodegen", "exit 0")
        self.mock("xcodebuild", '''
if [ "${1:-}" = -version ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
    case "$1" in
        -derivedDataPath) derived=$2; shift ;;
        -scheme) name=$2; shift ;;
        -configuration) configuration=$2; shift ;;
    esac
    shift
done
if [ "${AQT_TEST_MISSING_BUILD:-}" != 1 ]; then
    mkdir -p "$derived/Build/Products/$configuration/$name.app"
fi
''')
        self.mock("codesign", "exit 0")
        self.mock("pgrep", '[ "${AQT_TEST_OLD_RUNNING:-}" = 1 ]')
        self.mock("osascript", "exit 0")
        self.mock("sleep", "exit 0")
        self.mock("open", 'printf "%s\\n" "$*" > "$AQT_TEST_LAUNCH_LOG"')
        self.mock("ps", 'printf "%s\\n" "${AQT_TEST_RUNNING_BINARY:-}"')
        self.env["AQT_TEST_LAUNCH_LOG"] = str(self.root / "launch.log")

    def mock(self, name, body):
        path = self.bin_dir / name
        path.write_text(f"#!/bin/sh\nset -eu\n{body}\n")
        path.chmod(0o755)

    def run_app(self, *options):
        return subprocess.run(
            ["sh", str(self.script), str(self.app_dir), "Notch", "com.aquitano.notch", *options],
            env=self.env, text=True, capture_output=True, check=False,
        )

    def test_build_requires_an_app_bundle(self):
        self.env["AQT_TEST_MISSING_BUILD"] = "1"
        result = self.run_app()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("was not created", result.stderr)

    def test_running_old_instance_blocks_launch(self):
        self.env["AQT_TEST_OLD_RUNNING"] = "1"
        result = self.run_app("--run")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "launch.log").exists())

    def test_another_build_does_not_count_as_success(self):
        self.env["AQT_TEST_RUNNING_BINARY"] = "/elsewhere/Notch.app/Contents/MacOS/Notch"
        result = self.run_app("--run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not stay running", result.stderr)

    def test_launch_matches_exact_build_with_spaces(self):
        app = self.app_dir / "DerivedData/Build/Products/Debug/Notch.app"
        self.env["AQT_TEST_RUNNING_BINARY"] = str(app / "Contents/MacOS/Notch")
        result = self.run_app("--run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "launch.log").read_text().strip(), f"-n {app}")

    def test_launch_resolves_a_symlinked_project_directory(self):
        project = self.app_dir
        self.app_dir = self.root / "project alias with spaces"
        self.app_dir.symlink_to(project, target_is_directory=True)
        app = project / "DerivedData/Build/Products/Debug/Notch.app"
        self.env["AQT_TEST_RUNNING_BINARY"] = str(app / "Contents/MacOS/Notch")
        result = self.run_app("--run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "launch.log").read_text().strip(), f"-n {app}")

    def prepare_install(self):
        # Substitute only the system destination in a test-local copy; every
        # filesystem operation then runs under TemporaryDirectory.
        install_dir = self.root / "Applications"
        install_dir.mkdir()
        self.installed = install_dir / "Notch.app"
        self.installed.mkdir()
        (self.installed / "previous-marker").write_text("previous")
        original = self.script.read_text()
        self.assertEqual(original.count("install_dir=/Applications"), 1)
        self.script = self.root / "runner.sh"
        self.script.write_text(
            original.replace("install_dir=/Applications", f"install_dir={shlex.quote(str(install_dir))}")
            .replace('install_dir="$HOME/Applications"', f"install_dir={shlex.quote(str(install_dir))}")
        )
        self.mock("ditto", 'cp -R "$1" "$2"')
        self.env["AQT_TEST_RUNNING_BINARY"] = str(self.installed / "Contents/MacOS/Notch")
        return install_dir

    def test_copy_user_uses_the_prebuilt_app_without_rebuilding_or_launching(self):
        self.prepare_install()
        built = self.app_dir / "DerivedData/Build/Products/Debug/Notch.app"
        built.mkdir(parents=True)
        self.mock("xcodebuild", "exit 1")
        self.mock("xcodegen", "exit 1")
        result = self.run_app("--copy-user")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.installed.is_dir())
        self.assertFalse((self.root / "launch.log").exists())

    def test_unsigned_build_is_not_launched(self):
        self.mock("codesign", "exit 1")
        result = self.run_app("--run")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "launch.log").exists())

    def test_copy_is_verified_before_old_app_is_removed(self):
        self.prepare_install()
        self.mock("codesign", 'case "$*" in *DerivedData*) exit 0;; *) exit 1;; esac')
        result = self.run_app("--install")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.installed / "previous-marker").exists())

    def test_failed_install_restores_the_previous_app(self):
        install_dir = self.prepare_install()
        self.mock("mv", '''
case "$1" in */.Notch.*/Notch.app) exit 1;; esac
exec /bin/mv "$@"
''')
        result = self.run_app("--install")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.installed / "previous-marker").exists())
        self.assertEqual(list(install_dir.glob(".Notch.*")), [])

    def test_signal_between_moves_restores_the_previous_app(self):
        self.prepare_install()
        self.mock("mv", '''
/bin/mv "$@"
case "$2" in */previous.app) kill -TERM "$PPID";; esac
''')
        result = self.run_app("--install")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.installed / "previous-marker").exists())

    def test_failed_rollback_preserves_the_backup(self):
        install_dir = self.prepare_install()
        self.mock("mv", '''
case "$1" in */.Notch.*/Notch.app|*/previous.app) exit 1;; esac
exec /bin/mv "$@"
''')
        result = self.run_app("--install")
        self.assertNotEqual(result.returncode, 0)
        backups = list(install_dir.glob(".Notch.*/previous.app/previous-marker"))
        self.assertEqual(len(backups), 1)
        self.assertIn("previous app retained at", result.stderr)

    def test_failed_launch_keeps_the_new_app(self):
        install_dir = self.prepare_install()
        self.env["AQT_TEST_RUNNING_BINARY"] = "/elsewhere/Notch.app/Contents/MacOS/Notch"
        result = self.run_app("--install")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not stay running", result.stderr)
        self.assertFalse((self.installed / "previous-marker").exists())
        self.assertEqual(list(install_dir.glob(".Notch.*")), [])

    def test_successful_install_removes_the_backup(self):
        install_dir = self.prepare_install()
        result = self.run_app("--install")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.installed.is_dir())
        self.assertFalse((self.installed / "previous-marker").exists())
        self.assertEqual(list(install_dir.glob(".Notch.*")), [])


if __name__ == "__main__":
    unittest.main()
