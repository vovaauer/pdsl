#!/bin/bash
set -e # Exit immediately if a command exits with a non-zero status.

echo "PDSL Multi-Repo Deployment Script"
echo "---------------------------------"

# Get commit message
read -p "Enter commit message for this deployment: " COMMIT_MESSAGE
if [ -z "$COMMIT_MESSAGE" ]; then
    echo "Commit message cannot be empty. Aborting."
    exit 1
fi

MAIN_DIR=$(pwd)
echo "Main project directory set to: $MAIN_DIR"
echo ""

# Deploy the main 'pdsl' repository first
echo "🚀 Deploying 'pdsl' (frontend and control plane)..."
git add .
git commit -m "$COMMIT_MESSAGE"
git push origin main
echo "✅ 'pdsl' deployed."
echo ""

# Find and deploy all 'pdsl-shard-*' repositories
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
    git init
    git remote add origin "https://github.com/vovaauer/${repo_name}.git" # Change username if needed
    git branch -M main
  fi
  
  LICENSE_SOURCE_PATH="$MAIN_DIR/LICENSE"
  if [ -f "$LICENSE_SOURCE_PATH" ]; then
    cp "$LICENSE_SOURCE_PATH" .
  else
    echo "!! ERROR: LICENSE file not found at '$LICENSE_SOURCE_PATH'."
    exit 1
  fi

  echo "Adding all files to the Git index..."
  echo "(This can take several minutes on the first run, please be patient...)"
  git add .
  echo "✅ Files added."
  
  # --- CORRECTED: Robust Commit Logic ---
  echo "Committing files..."
  # Check if a HEAD commit exists. If not, this is the first commit.
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    # HEAD exists, so this is a subsequent commit. We can amend.
    echo "Amending previous commit to keep history small..."
    git commit --amend --allow-empty -m "$COMMIT_MESSAGE"
    
    echo "Pushing to remote repository (force required for amend)..."
    git push origin main --force
  else
    # HEAD does not exist, this is the very first commit. We must create it normally.
    echo "Creating initial commit for new repository..."
    git commit -m "$COMMIT_MESSAGE"
    
    echo "Pushing to remote repository (force required for initial push)..."
    # We use --force here to overwrite any initial commits (like a README)
    # that might have been created on GitHub, ensuring our local state is the source of truth.
    git push origin main --force
  fi
  # --- END CORRECTED ---

  echo "✅ '$repo_name' changes deployed."
  
  cd "$MAIN_DIR"
  echo ""
done

echo "🎉 All repositories have been updated successfully!"