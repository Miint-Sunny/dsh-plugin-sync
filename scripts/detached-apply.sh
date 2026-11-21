#!/bin/sh
set -eu
LOG=$1
shift
nohup "$@" </dev/null >>"$LOG" 2>&1 &
printf '%s\n' "$!"
