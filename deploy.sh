#!/bin/bash
set -e # Exit immediately if a command exits with a non-zero status.

echo "PDSL Multi-Repo Deployment Script"
echo "---------------------------------"

# 1. Get commit message
read -p "Enter commit message for this deployment: " COMMIT_MESSAGE
if [ -z "$COMMIT_MESSAGE" ]; then
    echo "Commit message cannot be empty. Aborting."
    exit 1
fi

# 2. Deploy the main 'pdsl' repository first
echo "🚀 Deploying 'pdsl' (frontend and control plane)..."
git add .
git commit -m "$COMMIT_MESSAGE"
git push origin main
echo "✅ 'pdsl' deployed."
echo ""

# 3. Find and deploy all 'pdsl-shard-*' repositories
# This script assumes it's in 'pdsl' and shards are sibling folders.
SHARD_DIR_PATH="../"
SHARDS=$(find "$SHARD_DIR_PATH" -maxdepth 1 -type d -name "pdsl-shard-*" | sort)

if [ -z "$SHARDS" ]; then
    echo "No shard directories found. Finished."
    exit 0
fi

for repo_path in $SHARDS
do
  repo_name=$(basename "$repo_path")
  echo "🚀 Deploying '$repo_name'..."
  cd "$repo_path"
  
  if [ ! -d ".git" ]; then
    echo "First time deployment for $repo_name. Initializing..."
    # You must have created the empty repo on GitHub first!
    git init
    # IMPORTANT: Change the username to your own!
    git remote add origin "https://github.com/vovaauer/${repo_name}.git"
    git branch -M main
  fi
  
  git add .
  
  # Use --allow-empty in case there are no changes to a shard
  # Use --amend to squash history and keep the repo size small
  echo "Committing and force-pushing to keep repo history small..."
  # Check if there are any changes to commit to avoid errors on unchanged repos
  if ! git diff-index --quiet HEAD --; then
      git commit --amend -m "$COMMIT_MESSAGE"
      git push origin main --force
      echo "✅ '$repo_name' changes deployed."
  else
      echo "✅ '$repo_name' has no changes."
  fi
  
  cd "../pdsl" # Go back to our base directory
  echo ""
done

echo "🎉 All repositories have been updated successfully!"