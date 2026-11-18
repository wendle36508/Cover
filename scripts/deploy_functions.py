"""Deploy Cover's server functions to Supabase, but only after every check passes.

The website is protected by GitHub (.github/workflows/deploy-site.yml). Server functions are deployed
from this computer, so this script is their gate: it runs the full test suite and the type check
first, and stops without deploying anything if one fails.

Run:
    python scripts/deploy_functions.py                     # test, then deploy every function
    python scripts/deploy_functions.py sponsor-email       # test, then deploy just these
    python scripts/deploy_functions.py --check-only        # run the checks, deploy nothing
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FUNCTIONS_DIR = REPO / "supabase" / "functions"
SUPABASE_CLI = "supabase@3.1.0"
DENO = "deno@2"


class DeployProblem(Exception):
    """A check failed or something needed is missing."""


def all_functions(folder: Path = FUNCTIONS_DIR) -> list[str]:
    """Every deployable function: a folder with an index.ts (shared code folders start with _)."""
    return sorted(p.name for p in folder.iterdir() if p.is_dir() and not p.name.startswith("_") and (p / "index.ts").is_file())


def pick_functions(requested: list[str], available: list[str]) -> list[str]:
    """The functions to deploy. Nothing requested means all of them; unknown names are an error."""
    if not requested:
        return available
    unknown = sorted(set(requested) - set(available))
    if unknown:
        raise DeployProblem(f"Unknown function(s): {', '.join(unknown)}. Choose from: {', '.join(available)}")
    return sorted(set(requested))


def tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise DeployProblem(f"'{name}' isn't installed or isn't on PATH.")
    return path


def checks(functions: list[str]) -> list[tuple[str, list[str]]]:
    """Each check as (label, command)."""
    npx = tool("npx")
    entry_points = [str(FUNCTIONS_DIR / name / "index.ts") for name in functions]
    config = str(FUNCTIONS_DIR / "deno.json")
    return [
        ("Site and database tests", [tool("npm"), "test"]),
        ("Server code type check", [npx, "--yes", DENO, "check", "--no-lock", "--config", config, *entry_points]),
        ("Server code lint", [npx, "--yes", DENO, "lint", "--config", config, str(FUNCTIONS_DIR)]),
    ]


def run_step(label: str, command: list[str]) -> None:
    print(f"-> {label}")
    result = subprocess.run(command, check=False, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-25:])
        raise DeployProblem(f"{label} failed. Nothing was deployed.\n{tail}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Test, then deploy Cover's Supabase functions.")
    parser.add_argument("functions", nargs="*", help="function names (default: all)")
    parser.add_argument("--check-only", action="store_true", help="run the checks, deploy nothing")
    args = parser.parse_args(argv)
    try:
        functions = pick_functions(args.functions, all_functions())
        for label, command in checks(functions):
            run_step(label, command)
        print("All checks passed.")
        if args.check_only:
            return 0
        npx = tool("npx")
        for name in functions:
            run_step(f"Deploy {name}", [npx, "--yes", SUPABASE_CLI, "functions", "deploy", name, "--use-api", "--yes"])
        print(f"Deployed: {', '.join(functions)}")
    except DeployProblem as problem:
        print(problem, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
