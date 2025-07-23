import os
import re
import json
import time
from collections import defaultdict
from tqdm import tqdm
from multiprocessing import Pool, cpu_count
import shutil

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE_FILE_PATH = os.path.join(BASE_DIR, 'servers.jsonl')
SHARD_REPO_PREFIX = 'pdsl-shard-{}'
DOCS_PER_DATA_FILE = 500
SERVERS_PER_SHARD = 200000  # NEW: Max number of servers per shard repository
SHARD_PREFIX_LENGTH = 2
GITHUB_USERNAME = 'vovaauer'
INDEX_CONFIG = {
    'text': ["invite", "inviter.username", "inviter.global_name", "guild.name", "guild.description", "channel.name", "profile.tag", "profile.traits"],
    'keyword': ["inviter.id", "guild.id", "guild.features", "guild.vanity_url_code", "channel.id", "guild.nsfw", "guild.premium_tier", "guild.verification_level"],
    'numeric': ["profile.member_count", "profile.online_count", "guild.premium_subscription_count"]
}
STOP_WORDS = {'the', 'and', 'for', 'with', 'new', 'you', 'are', 'server', 'our', 'from', 'a', 'is', 'in', 'it', 'us', 'to', 'of', 'we'}

# --- HELPER FUNCTIONS (Unchanged) ---
def simple_stem(word):
    if len(word) > 3 and word.endswith('s'): return word[:-1]
    return word
def tokenize(text):
    if not text or not isinstance(text, str): return []
    text = text.lower()
    words = re.findall(r'\b[a-z0-9]{2,}\b', text)
    return [simple_stem(word) for word in words if word not in STOP_WORDS and len(word) < 100]
def get_nested_val(data, path):
    keys = path.split('.')
    temp_data = data
    for key in keys:
        if isinstance(temp_data, dict): temp_data = temp_data.get(key)
        else: return None
    return temp_data

# --- WORKER FUNCTIONS (Unchanged) ---
def initial_parse_line(line):
    try:
        data = json.loads(line)
        if data.get('status') == 'valid' and get_nested_val(data, 'response.guild.id'):
            return data
    except json.JSONDecodeError: pass
    return None
def process_final_doc(doc_with_id_tuple):
    internal_id, data = doc_with_id_tuple
    doc_to_store = {"internal_id": internal_id, "data": {"id": get_nested_val(data, 'response.guild.id'), "invite": data.get('invite'), **data.get('response', {})}}
    index_pointers = []
    member_count = get_nested_val(doc_to_store, 'data.profile.member_count') or 0
    online_count = get_nested_val(doc_to_store, 'data.profile.online_count') or 0
    rich_pointer = {"id": internal_id, "mc": member_count, "oc": online_count}
    for field in INDEX_CONFIG['text']:
        values_to_process = []
        if field == 'invite': raw_val = data.get('invite')
        else: raw_val = get_nested_val(data, f'response.{field}')
        if field == 'profile.traits':
            if isinstance(raw_val, list):
                for trait in raw_val:
                    if isinstance(trait, dict) and 'label' in trait and trait['label']: values_to_process.append(trait['label'])
        elif isinstance(raw_val, str): values_to_process.append(raw_val)
        elif isinstance(raw_val, list): values_to_process.extend(item for item in raw_val if isinstance(item, str))
        for text_item in values_to_process:
            for token in tokenize(text_item): index_pointers.append((field, token, rich_pointer))
    for field_type in ['keyword', 'numeric']:
        for field in INDEX_CONFIG[field_type]:
            value = get_nested_val(data, f'response.{field}')
            if isinstance(value, list):
                for item in value: index_pointers.append((field, str(item), rich_pointer))
            elif value is not None: index_pointers.append((field, str(value), rich_pointer))
    return doc_to_store, index_pointers, member_count
def update_data_batch(task_tuple):
    repo_num, batch_id, docs = task_tuple
    data_file_path = os.path.join(BASE_DIR, '..', SHARD_REPO_PREFIX.format(repo_num), 'data', f'd_{batch_id}.json')
    os.makedirs(os.path.dirname(data_file_path), exist_ok=True)
    with open(data_file_path, 'w', encoding='utf-8') as f: json.dump(docs, f)


def main():
    print("🚀 PDSL Clean Build Processor with Deduplication and Sharding")
    with open(SOURCE_FILE_PATH, 'r', encoding='utf-8') as f:
        lines_to_process = f.readlines()
    if not lines_to_process: return

    print(f"⚙️ Stage 1/5: Parsing and deduplicating {len(lines_to_process)} raw lines...")
    with Pool(cpu_count()) as pool:
        initial_results = list(tqdm(pool.imap_unordered(initial_parse_line, lines_to_process, chunksize=2000), total=len(lines_to_process)))
    valid_initial_docs = [doc for doc in initial_results if doc is not None]
    deduplicated_servers = {}
    for doc in tqdm(valid_initial_docs, desc="Finding best entry per server"):
        guild_id = get_nested_val(doc, 'response.guild.id')
        if not guild_id: continue
        member_count = get_nested_val(doc, 'response.profile.member_count') or 0
        if guild_id not in deduplicated_servers or member_count > deduplicated_servers[guild_id]['member_count']:
            deduplicated_servers[guild_id] = {'data': doc, 'member_count': member_count}
    final_docs_to_process = [v['data'] for v in deduplicated_servers.values()]
    print(f"Found {len(final_docs_to_process)} unique servers.")

    print(f"\n⚙️ Stage 2/5: Processing {len(final_docs_to_process)} unique servers...")
    processing_tasks = list(enumerate(final_docs_to_process))
    with Pool(cpu_count()) as pool:
        final_results = list(tqdm(pool.imap_unordered(process_final_doc, processing_tasks, chunksize=1000), total=len(processing_tasks)))
    all_docs, all_pointers_flat, all_member_counts = zip(*final_results)
    total_valid_servers = len(all_docs)
    total_shards = (total_valid_servers + SERVERS_PER_SHARD - 1) // SERVERS_PER_SHARD
    print(f"Dataset will be split into {total_shards} shard(s).")

    print(f"\n⚙️ Stage 3/5: Writing data and index files...")
    # Group data documents by shard and then by batch file
    docs_by_repo_and_batch = defaultdict(lambda: defaultdict(list))
    for doc in all_docs:
        repo_num = doc['internal_id'] // SERVERS_PER_SHARD + 1
        batch_id = (doc['internal_id'] % SERVERS_PER_SHARD) // DOCS_PER_DATA_FILE
        docs_by_repo_and_batch[repo_num][batch_id].append(doc)
    
    data_writing_tasks = []
    for repo_num, batches in docs_by_repo_and_batch.items():
        for batch_id, docs in batches.items():
            data_writing_tasks.append((repo_num, batch_id, docs))
            
    with Pool(cpu_count()) as pool:
        list(tqdm(pool.imap_unordered(update_data_batch, data_writing_tasks), total=len(data_writing_tasks), desc="Writing data batches"))
    
    # Group index pointers by shard
    indexes_by_shard = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for i, pointers_list in enumerate(all_pointers_flat):
        internal_id = all_docs[i]['internal_id']
        repo_num = internal_id // SERVERS_PER_SHARD + 1
        for field, token, rich_pointer in pointers_list:
            indexes_by_shard[repo_num][field][token].append(rich_pointer)
            
    # Write index files for each shard
    for repo_num, final_index in tqdm(indexes_by_shard.items(), desc="Writing shard indexes"):
        for field, tokens in final_index.items():
            updates_by_shard_file = defaultdict(dict)
            for token, rich_pointers in tokens.items():
                shard_key = token[:SHARD_PREFIX_LENGTH] if len(token) >= SHARD_PREFIX_LENGTH else '_'
                updates_by_shard_file[shard_key][token] = rich_pointers
            
            field_path = os.path.join(BASE_DIR, '..', SHARD_REPO_PREFIX.format(repo_num), 'index', field.replace('.', '_'))
            os.makedirs(field_path, exist_ok=True)
            for shard_key, updates in updates_by_shard_file.items():
                with open(os.path.join(field_path, f'{shard_key}.json'), 'w', encoding='utf-8') as f: json.dump(updates, f)

    print(f"\n⚙️ Stage 4/5: Generating final manifests...")
    server_sort_data = sorted([(mc, doc['internal_id']) for doc, mc in zip(all_docs, all_member_counts)], key=lambda x: x[0], reverse=True)
    sorted_ids = [item[1] for item in server_sort_data]
    # NOTE: Moved global sorted index to the main directory, not a shard.
    sorted_index_path = os.path.join(BASE_DIR, 'all_servers_sorted_by_members.json')
    with open(sorted_index_path, 'w', encoding='utf-8') as f: json.dump(sorted_ids, f)
    
    # Create the full numeric index from all shards combined
    full_numeric_index = defaultdict(set)
    for repo_num in indexes_by_shard:
        for field in INDEX_CONFIG['numeric']:
            if field in indexes_by_shard[repo_num]:
                for v in indexes_by_shard[repo_num][field].keys():
                    full_numeric_index[field].add(int(v))
    
    numeric_manifest = {field: sorted(list(values)) for field, values in full_numeric_index.items()}
    # NOTE: Moved global numeric manifest to the main directory.
    numeric_manifest_path = os.path.join(BASE_DIR, 'numeric_manifest.json')
    with open(numeric_manifest_path, 'w', encoding='utf-8') as f: json.dump(numeric_manifest, f)
    
    data_shard_map = []
    for i in range(total_shards):
        data_shard_map.append({
            "repo": i + 1,
            "start_id": i * SERVERS_PER_SHARD,
            "end_id": (i + 1) * SERVERS_PER_SHARD - 1
        })
    # Adjust end_id for the very last shard
    if data_shard_map:
        data_shard_map[-1]['end_id'] = total_valid_servers - 1

    manifest = {
        "last_updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_servers": total_valid_servers,
        "total_shards": total_shards,
        "servers_per_shard": SERVERS_PER_SHARD,
        "repo_base_url": f"https://{GITHUB_USERNAME}.github.io",
        "repo_name_template": "/pdsl-shard-{}",
        "docs_per_file": DOCS_PER_DATA_FILE,
        "data_shard_map": data_shard_map
    }
    with open(os.path.join(BASE_DIR, 'manifest.json'), 'w') as f: json.dump(manifest, f, indent=2)

    print(f"\n⚙️ Stage 5/5: Finalizing shard repositories...")
    license_source_path = os.path.join(BASE_DIR, 'LICENSE')
    if not os.path.exists(license_source_path):
        print("!! WARNING: LICENSE file not found in build directory. Skipping license copy.")
    else:
        for i in range(total_shards):
            shard_dir = os.path.join(BASE_DIR, '..', SHARD_REPO_PREFIX.format(i + 1))
            if os.path.isdir(shard_dir):
                print(f"Copying LICENSE to {os.path.basename(shard_dir)}...")
                shutil.copy(license_source_path, shard_dir)
            
    print(f"\n✅ Clean build complete! System now has {total_valid_servers} unique servers across {total_shards} shard(s).")

if __name__ == '__main__':
    main()