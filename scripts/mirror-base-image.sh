#!/usr/bin/env bash
# Mirror the pinned Node base image into a China ECR repository (Ops plan §3). Idempotent.
#
#   AWS_PROFILE=<china-profile> scripts/mirror-base-image.sh <region>     # cn-north-1 | cn-northwest-1
#
# - creates ECR repo gcr-im-mcp/base/node (IMMUTABLE tags, scan on push) if missing
# - sets the repo policy so the CDK image-publishing role can pull the base image during `cdk deploy`
#   (cdk-assets logs in with that role before `docker build`, so FROM pulls run as the role)
# - pulls the linux/arm64 image from public.ecr.aws and pushes it, unless the tag already exists
# - prints the pushed digest; pin it in shared/versions.ts CN_BASE_DIGEST (or config build.baseImage)
#
# Must run where both public.ecr.aws and the China ECR registry are reachable.
# The repo lives outside the CDK stack on purpose: `cdk destroy` must not delete a shared base image.
set -euo pipefail

REGION="${1:-${AWS_REGION:-}}"
case "$REGION" in
  cn-north-1|cn-northwest-1) ;;
  *) echo "usage: $0 <cn-north-1|cn-northwest-1>" >&2; exit 2 ;;
esac
export AWS_REGION="$REGION"   # China credentials need a China region for STS

HERE="$(cd "$(dirname "$0")" && pwd)"
VERSIONS="$HERE/../shared/versions.ts"
SRC="$(grep -A1 '^export const GLOBAL_BASE_IMAGE' "$VERSIONS" | grep -o "'[^']*'" | tr -d "'")"
REPO="$(sed -n "s/^export const CN_BASE_REPO = '\(.*\)';.*/\1/p" "$VERSIONS")"
TAG="${MIRROR_TAG:-22-bookworm-slim}"
QUALIFIER="${CDK_QUALIFIER:-hnb659fds}"
if [ -z "$SRC" ] || [ -z "$REPO" ]; then
  echo "could not read GLOBAL_BASE_IMAGE / CN_BASE_REPO from $VERSIONS" >&2; exit 1
fi

ACCT="$(aws sts get-caller-identity --region "$REGION" --query Account --output text)"
PARTITION="$(aws sts get-caller-identity --region "$REGION" --query Arn --output text | cut -d: -f2)"
[ "$PARTITION" = "aws-cn" ] || { echo "credentials are for partition '$PARTITION', expected aws-cn" >&2; exit 1; }
REG="$ACCT.dkr.ecr.$REGION.amazonaws.com.cn"
DST="$REG/$REPO:$TAG"

echo "source: $SRC"
echo "target: $DST"

if ! aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1; then
  aws ecr create-repository --region "$REGION" --repository-name "$REPO" \
    --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true >/dev/null
  echo "created repository $REPO"
else
  echo "repository $REPO exists"
fi

POLICY="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "CdkImagePublishingPull",
    "Effect": "Allow",
    "Principal": { "AWS": "arn:$PARTITION:iam::$ACCT:role/cdk-$QUALIFIER-image-publishing-role-$ACCT-$REGION" },
    "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
  }]
}
EOF
)"
aws ecr set-repository-policy --region "$REGION" --repository-name "$REPO" --policy-text "$POLICY" >/dev/null
echo "repository policy set for the CDK image-publishing role"

DIGEST="$(aws ecr describe-images --region "$REGION" --repository-name "$REPO" --image-ids imageTag="$TAG" \
  --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)"
if [ -n "$DIGEST" ] && [ "$DIGEST" != "None" ]; then
  echo "tag $TAG already present; skipping push"
else
  aws ecr get-login-password --region "$REGION" | docker login -u AWS --password-stdin "$REG" >/dev/null
  docker pull --platform linux/arm64 "$SRC"
  docker tag "$SRC" "$DST"
  docker push "$DST"
  DIGEST="$(aws ecr describe-images --region "$REGION" --repository-name "$REPO" --image-ids imageTag="$TAG" \
    --query 'imageDetails[0].imageDigest' --output text)"
fi

echo
echo "digest: $DIGEST"
echo "Pin it: shared/versions.ts CN_BASE_DIGEST = '$DIGEST' (must match in every China region you deploy to),"
echo "or set build.baseImage: $REG/$REPO@$DIGEST in the config."
