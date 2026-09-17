#!/usr/bin/env python3
"""Synchronize the semester catalog using staged files or --worktree."""
import subprocess
import sys

sys.dont_write_bytecode = True
from hook_lib import main

if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f'检查失败：{error}', file=sys.stderr)
        sys.exit(1)
