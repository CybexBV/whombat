#!/bin/sh
# Copy all qualification evidence to a WBFACTORY medium for the record sheet.
set -eu
mkdir -p /run/hq-medium
mount /dev/disk/by-label/WBFACTORY /run/hq-medium
mkdir -p /run/hq-medium/hq
cp -r /persist/hq/. /run/hq-medium/hq/
sync; umount /run/hq-medium
echo "evidence copied"
