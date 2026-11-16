#!/bin/bash
# Terminal-friendly launcher for the portable macOS bundle.
# Equivalent to double-clicking "Start Me.command".

cd "$(dirname "$0")" || exit 1
exec bash "Start Me.command"
