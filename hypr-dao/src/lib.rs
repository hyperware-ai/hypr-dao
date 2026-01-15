use hyperware_process_lib::eth::{Bytes, TransactionInput, TransactionRequest};
use alloy_primitives::{Address as EthAddress, FixedBytes, B256, U256};
use alloy_sol_macro::sol;
use alloy_sol_types::SolCall;
use alloy_sol_types::SolEvent;
use hyperware_process_lib::{
    bindings::{Bindings, LockDetails as OnchainLockDetails, RegistrationDetails},
    dao::{DaoContracts, HyperwareGovernor, DAO_FIRST_BLOCK},
    eth::{BlockNumberOrTag, Filter as EthFilter, Provider},
    homepage::add_to_homepage,
    wait_for_process_ready,
    our,
    println,
    Address, Message, Request, WaitClassification, get_state, set_state,
};
use rmp_serde;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;

const ICON: &str = include_str!("./icon");
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_CHAIN_ID: u64 = 8453;
#[cfg(feature = "simulation-mode")]
const LOCAL_CHAIN_ID: u64 = 31337;
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_TOKEN_REGISTRY: &str = "0x0000000000e8d224B902632757d5dbc51a451456";
#[cfg(feature = "simulation-mode")]
const LOCAL_TOKEN_REGISTRY: &str = "0x326Aa6822847B97a8387445a497e01253aC6E82B";
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_GOVERNOR: &str = "0x000000000048395579c3C60f2F8Cb2DECa457550";
#[cfg(feature = "simulation-mode")]
const LOCAL_GOVERNOR: &str = "0x45d8B75bb9A961E88486C470bcf8aa13E506Ec9B";
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_TIMELOCK: &str = "0x0000000000c3442cbc1E194BBD6f74713816e51B";
#[cfg(feature = "simulation-mode")]
const LOCAL_TIMELOCK: &str = "0x322D23640D57f36aE058FCc43e02C2A307678166";
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_VOTES_TOKEN: &str = "0x00000000004a50Daa1B759C47Ebf4239163aE5be";
#[cfg(feature = "simulation-mode")]
const LOCAL_VOTES_TOKEN: &str = "0xec48905Bb1714bbf3B6f56E49a8FA2299Bfa55f5";
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_DAO_FIRST_BLOCK: u64 = 40_000_000;
#[cfg(feature = "simulation-mode")]
const LOCAL_DAO_FIRST_BLOCK: u64 = 0;

#[cfg(not(feature = "simulation-mode"))]
const MIN_LOCK_DURATION_SECONDS: u64 = 4 * 7 * 24 * 60 * 60;
#[cfg(feature = "simulation-mode")]
const MIN_LOCK_DURATION_SECONDS: u64 = 4 * 60;
const HNS_INDEXER_TIMEOUT_S: u64 = 5;
const ZERO_NAMEHASH: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CHAIN_REFRESH_CACHE_FALLBACK_SECONDS: i64 = 2 * 60 * 60;

mod hns_indexer_api {
    wit_bindgen::generate!({
        path: "../api/hns-indexer-wit/hns-indexer:sys-v0.wit",
        world: "hns-indexer-sys-v0",
        generate_unused_types: true,
        additional_derives: [serde::Deserialize, serde::Serialize, process_macros::SerdeJsonInto],
    });
}

mod dao_cacher_api {
    wit_bindgen::generate!({
        path: "../api/hypermap-cacher:sys-v2.wit",
        world: "hypermap-cacher-sys-v2",
        generate_unused_types: true,
        additional_derives: [serde::Deserialize, serde::Serialize, process_macros::SerdeJsonInto],
    });
}

use hns_indexer_api::hyperware::process::hns_indexer::{
    IndexerRequest, IndexerResponse, NamehashToNameRequest,
};
use dao_cacher_api::hyperware::process::dao_cacher::{
    DaoCacherRequest, DaoCacherResponse, DaoGetLogsByRangeOkResponse, DaoGetLogsByRangeRequest,
};
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct LockDetailsView {
    amount_raw_wei: String,
    amount_formatted_hypr: String,
    unlock_timestamp: u64,
    remaining_seconds: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct BalanceView {
    amount_raw_wei: String,
    amount_formatted_hypr: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct BindDetailsView {
    namehash: String,
    name: Option<String>,
    amount_raw_wei: String,
    amount_formatted_hypr: String,
    unlock_timestamp: u64,
    remaining_seconds: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct ProposalView {
    proposal_id: String,
    proposer: String,
    description: String,
    start_block: u64,
    end_block: u64,
    state: u8,
    queued_at: u64,
    execute_after: u64,
    min_delay_seconds: u64,
    executed_at: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct QuorumProgress {
    percent: f64,
    bps: u64,
    counted: String,
    required: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct VotingPowerAtSnapshot {
    has_power: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct VoteView {
    voter: String,
    support: u8,
    weight: String,
    reason: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct ProposalIndexEntry {
    proposal_id: String,
    proposer: String,
    description: String,
    start_block: u64,
    end_block: u64,
    queued_block: Option<u64>,
    execute_after: Option<u64>,
    executed_block: Option<u64>,
    state: Option<u8>,
    eta: Option<u64>,
    queued_at: Option<u64>,
    executed_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct DaoIndex {
    last_block: u64,
    proposals_indexed: usize,
    proposals: HashMap<String, ProposalIndexEntry>,
    votes: HashMap<String, Vec<VoteView>>,
    quorum: HashMap<String, QuorumProgress>,
}

sol! {
    #[allow(non_camel_case_types)]
    event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason);

    #[allow(non_camel_case_types)]
    contract GovernorHasVoted {
        function hasVoted(uint256 proposalId, address account) external view returns (bool);
    }

    #[allow(non_camel_case_types)]
    event ProposalQueued(uint256 proposalId, uint256 eta);
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct LockStatusPayload {
    node_id: String,
    owner_address: Option<String>,
    lock_details: Option<LockDetailsView>,
    hypr_owned: Option<BalanceView>,
    hypr_approved: Option<BalanceView>,
    tokeregistry_allowance: Option<BalanceView>,
    hypr_token_address: Option<String>,
    available_to_bind: Option<BalanceView>,
    bindings: Vec<BindDetailsView>,
    error: Option<String>,
    lock_modal_seen: bool,
    chain_id: u64,
    min_lock_duration_seconds: u64,
}

#[derive(Serialize, Debug, Clone)]
struct HyprDaoState {
    #[serde(default)]
    dao_index: Option<DaoIndex>,
    #[serde(default)]
    confirmed_votes: HashMap<String, Vec<String>>,
    node_id: String,
    owner_address: Option<String>,
    owner_resolution_attempted: bool,
    lock_details: Option<LockDetailsView>,
    hypr_owned: Option<BalanceView>,
    hypr_approved: Option<BalanceView>,
    tokeregistry_allowance: Option<BalanceView>,
    hypr_token_address: Option<String>,
    available_to_bind: Option<BalanceView>,
    bindings: Vec<BindDetailsView>,
    last_error: Option<String>,
    lock_modal_seen: bool,
    #[serde(skip)]
    cache_sync_in_progress: bool,
    #[serde(skip)]
    chain_sync_in_progress: bool,
    #[serde(skip)]
    last_chain_sync_ts: Option<i64>,
}

impl Default for HyprDaoState {
    fn default() -> Self {
        Self {
            dao_index: None,
            confirmed_votes: HashMap::new(),
            node_id: String::new(),
            owner_address: None,
            owner_resolution_attempted: false,
            lock_details: None,
            hypr_owned: None,
            hypr_approved: None,
            tokeregistry_allowance: None,
            hypr_token_address: None,
            available_to_bind: None,
            bindings: Vec::new(),
            last_error: None,
            lock_modal_seen: false,
            cache_sync_in_progress: false,
            chain_sync_in_progress: false,
            last_chain_sync_ts: None,
        }
    }
}

impl<'de> Deserialize<'de> for HyprDaoState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Inner {
            dao_index: Option<DaoIndex>,
            confirmed_votes: HashMap<String, Vec<String>>,
            node_id: String,
            owner_address: Option<String>,
            owner_resolution_attempted: bool,
            lock_details: Option<LockDetailsView>,
            hypr_owned: Option<BalanceView>,
            hypr_approved: Option<BalanceView>,
            tokeregistry_allowance: Option<BalanceView>,
            hypr_token_address: Option<String>,
            available_to_bind: Option<BalanceView>,
            bindings: Vec<BindDetailsView>,
            last_error: Option<String>,
            lock_modal_seen: bool,
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wrapper {
            Full(Inner),
            DaoOnly(DaoIndex),
            LegacyString(()),
        }

        let wrapped: Wrapper = match Wrapper::deserialize(deserializer) {
            Ok(w) => w,
            Err(_) => return Ok(HyprDaoState::default()),
        };

        let inner = match wrapped {
            Wrapper::Full(v) => v,
            Wrapper::DaoOnly(idx) => Inner {
                dao_index: Some(idx),
                ..Default::default()
            },
            Wrapper::LegacyString(_) => Inner::default(),
        };

        Ok(HyprDaoState {
            dao_index: inner.dao_index,
            node_id: inner.node_id,
            owner_address: inner.owner_address,
            owner_resolution_attempted: inner.owner_resolution_attempted,
            lock_details: inner.lock_details,
            hypr_owned: inner.hypr_owned,
            hypr_approved: inner.hypr_approved,
            tokeregistry_allowance: inner.tokeregistry_allowance,
            hypr_token_address: inner.hypr_token_address,
            available_to_bind: inner.available_to_bind,
            bindings: inner.bindings,
            last_error: inner.last_error,
            lock_modal_seen: inner.lock_modal_seen,
            confirmed_votes: inner.confirmed_votes,
            cache_sync_in_progress: false,
            chain_sync_in_progress: false,
            last_chain_sync_ts: None,
        })
    }
}

fn confirmed_votes_key(voter: &str) -> Result<String, String> {
    let parsed = EthAddress::from_str(voter)
        .map_err(|_| "invalid voter address provided".to_string())?;
    let addr = format_address(parsed).to_lowercase();
    Ok(format!("{LOCAL_CHAIN_ID}:{addr}"))
}

#[hyperapp_macro::hyperapp(
    name = "HYPR DAO",
    ui = Some(hyperware_process_lib::http::server::HttpBindingConfig::default()),
    endpoints = vec![hyperware_process_lib::hyperapp::Binding::Http {
        path: "/api",
        config: hyperware_process_lib::http::server::HttpBindingConfig::default(),
    }],
    save_config = hyperware_process_lib::hyperapp::SaveOptions::OnDiff,
    wit_world = "hypr-dao-ware-dot-hypr-v0"
)]
impl HyprDaoState {
    #[local]
    fn load_checkpoint(&mut self) -> Result<(), String> {
        if let Some(bytes) = get_state() {
            match rmp_serde::from_slice::<HyprDaoState>(&bytes) {
                Ok(restored) => {
                    *self = restored;
                    if let Some(idx) = &self.dao_index {
                        println!(
                            "DAO index: loaded checkpoint start block {}",
                            idx.last_block
                        );
                    }
                    return Ok(());
                }
                Err(e) => println!("DAO index: failed to decode checkpoint: {e:?}"),
            }
        } else {
            println!("DAO index: no checkpoint found; starting fresh.");
        }
        Ok(())
    }

    #[local]
    fn save_checkpoint(&self) -> Result<(), String> {
        match rmp_serde::to_vec(self) {
            Ok(bytes) => {
                set_state(&bytes);
                let last = self
                    .dao_index
                    .as_ref()
                    .map(|d| d.last_block)
                    .unwrap_or(LOCAL_DAO_FIRST_BLOCK);
                println!("DAO index: saved checkpoint at block {}", last);
            }
            Err(e) => {
                println!("DAO index: failed to serialize checkpoint: {e:?}");
            }
        }
        Ok(())
    }

    #[local]
    fn fetch_dao_cacher_last_block(&self) -> Option<u64> {
        let address = Address::new("our", ("dao-cacher", "hypermap-cacher", "sys"));
        let response = Request::to(address)
            .body(DaoCacherRequest::GetStatus)
            .send_and_await_response(5)
            .ok()?
            .ok()?;
        let Message::Response { body, .. } = response else {
            return None;
        };
        match body.try_into() {
            Ok(DaoCacherResponse::GetStatus(status)) => Some(status.last_cached_block),
            _ => None,
        }
    }

    #[local]
    fn bootstrap_dao_index(&mut self) -> Result<(), String> {
        if self.dao_index.is_some() {
            println!("DAO index bootstrap skipped (index already present)");
            return Ok(());
        }
        println!("DAO index bootstrap starting (no existing index found)");
        let start_block = self
            .dao_index
            .as_ref()
            .map(|d| d.last_block)
            .unwrap_or(LOCAL_DAO_FIRST_BLOCK.saturating_sub(1));
        let last_block = start_block;
        println!(
            "DAO index bootstrap checkpoint set to {}",
            last_block
        );
        self.dao_index = Some(DaoIndex {
            last_block,
            proposals_indexed: 0,
            proposals: HashMap::new(),
            votes: HashMap::new(),
            quorum: HashMap::new(),
        });
        self.save_checkpoint()?;
        Ok(())
    }

    #[local]
    fn refresh_dao_index_from_cacher(&mut self) -> Result<(), String> {
        let Some(idx) = self.dao_index.clone() else {
            return Ok(());
        };
        self.cache_sync_in_progress = true;
        let result = (|| {
        let from_block = idx.last_block.saturating_add(1);
        let address = Address::new("our", ("dao-cacher", "hypermap-cacher", "sys"));
        let req = DaoGetLogsByRangeRequest {
            from_block,
            to_block: None,
        };
        match Request::to(address)
            .body(DaoCacherRequest::GetLogsByRange(req))
            .send_and_await_response(15)
        {
            Ok(Ok(message)) => {
                let Message::Response { body, .. } = message else {
                    return Ok(());
                };
                match body.try_into() {
                    Ok(DaoCacherResponse::GetLogsByRange(Ok(
                        DaoGetLogsByRangeOkResponse::Logs((block, json)),
                    ))) => {
                        let (log_count, span_from, span_to, new_props, new_votes) =
                            decode_cacher_logs(&json);
                        println!(
                            "dao-cacher delta: {} logs covering blocks {}-{} proposals touched: {}",
                            log_count,
                            span_from,
                            span_to,
                            new_props.len()
                        );
                        if let Some(mut current) = self.dao_index.clone() {
                            let mut touched_ids: Vec<String> = Vec::new();
                            for (k, v) in new_props {
                                touched_ids.push(k.clone());
                                match current.proposals.get_mut(&k) {
                                    Some(existing) => merge_proposal_entry(existing, v),
                                    None => {
                                        current.proposals.insert(k, v);
                                    }
                                }
                            }
                            for (k, vs) in new_votes {
                                let entry = current.votes.entry(k.clone()).or_default();
                                for v in vs {
                                    let voter = v.voter.to_lowercase();
                                    if entry.iter().any(|e| e.voter.to_lowercase() == voter) {
                                        continue;
                                    }
                                    entry.push(v);
                                }
                                touched_ids.push(k);
                            }
                            if block > current.last_block {
                                current.last_block = block;
                            }
                            current.proposals_indexed = current.proposals.len();
                            self.dao_index = Some(current);
                            // Hydrate proposals touched by new logs.
                            let _ = self.hydrate_index_entries(&touched_ids);
                            self.save_checkpoint()?;
                        }
                    }
                    Ok(DaoCacherResponse::GetLogsByRange(Ok(
                        DaoGetLogsByRangeOkResponse::Latest(block),
                    ))) => {
                        println!(
                            "dao-cacher latest: no logs in range; latest block {}",
                            block
                        );
                        if block > idx.last_block {
                            let mut new_idx = idx.clone();
                            new_idx.last_block = block;
                            self.dao_index = Some(new_idx);
                            self.save_checkpoint()?;
                        }
                    }
                    Ok(other) => {
                        println!("DAO index: unexpected dao-cacher response: {other:?}");
                    }
                    Err(err) => {
                        println!("DAO index: dao-cacher response parse error: {err}");
                    }
                }
            }
            Ok(Err(err)) => {
                println!("DAO index: dao-cacher request failed: {err}");
            }
            Err(err) => {
                println!("DAO index: dao-cacher request error: {err}");
            }
        }
        Ok(())
        })();
        self.cache_sync_in_progress = false;
        result
    }

    #[local]
    fn refresh_dao_index_from_chain(&mut self) -> Result<(), String> {
        let Some(idx) = self.dao_index.clone() else {
            return Ok(());
        };
        if self.cache_sync_in_progress || self.chain_sync_in_progress {
            return Ok(());
        }
        self.chain_sync_in_progress = true;
        let result = (|| {
        let dao = HyprDaoState::dao_client()?;
        let from_block = idx.last_block.saturating_add(1);
        let latest = match dao.provider.get_block_number() {
            Ok(block) => block,
            Err(err) => {
                return Err(format!("unable to fetch latest chain block: {err}"));
            }
        };
        if latest < from_block {
            return Ok(());
        }
        let (log_count, span_from, span_to, new_props, new_votes) =
            fetch_chain_logs(&dao, from_block, latest)?;
        println!(
            "dao-chain delta: {} logs covering blocks {}-{} proposals touched: {}",
            log_count,
            span_from,
            span_to,
            new_props.len()
        );
        if let Some(mut current) = self.dao_index.clone() {
            let mut touched_ids: Vec<String> = Vec::new();
            for (k, v) in new_props {
                touched_ids.push(k.clone());
                match current.proposals.get_mut(&k) {
                    Some(existing) => merge_proposal_entry(existing, v),
                    None => {
                        current.proposals.insert(k, v);
                    }
                }
            }
            for (k, vs) in new_votes {
                let entry = current.votes.entry(k.clone()).or_default();
                for v in vs {
                    let voter = v.voter.to_lowercase();
                    if entry.iter().any(|e| e.voter.to_lowercase() == voter) {
                        continue;
                    }
                    entry.push(v);
                }
                touched_ids.push(k);
            }
            if latest > current.last_block {
                current.last_block = latest;
            }
            current.proposals_indexed = current.proposals.len();
            self.dao_index = Some(current);
            let _ = self.hydrate_index_entries(&touched_ids);
            self.save_checkpoint()?;
        }
        self.last_chain_sync_ts = Some(current_unix_timestamp());
        Ok(())
        })();
        self.chain_sync_in_progress = false;
        result
    }

    #[init]
    async fn initialize(&mut self) {
        if let Err(e) = self.load_checkpoint() {
            println!("Failed to load persisted DAO checkpoint: {e}");
        }
        self.cache_sync_in_progress = false;
        self.chain_sync_in_progress = false;
        self.last_chain_sync_ts = None;
        let dao_cacher_addr = Address::new("our", ("dao-cacher", "hypermap-cacher", "sys"));
        println!(
            "Waiting for dao-cacher at {} to report ready before starting DAO indexing...",
            dao_cacher_addr
        );
        wait_for_process_ready(
            dao_cacher_addr.clone(),
            b"\"GetStatus\"".to_vec(),
            15,
            2,
            |body| {
                let body_str = String::from_utf8_lossy(body);
                if body_str.contains("IsStarting") || body_str.contains(r#""IsStarting""#) {
                    WaitClassification::Starting
                } else if body_str.contains("GetStatus") || body_str.contains("last_cached_block") {
                    WaitClassification::Ready
                } else {
                    WaitClassification::Unknown
                }
            },
            true,
            None,
        );
        println!("dao-cacher ready; bootstrapping DAO index.");
        if let Err(err) = self.bootstrap_dao_index() {
            println!("DAO index bootstrap failed: {err}");
        }
        if let Err(err) = self.refresh_dao_index_from_cacher() {
            println!("DAO index: initial refresh from dao-cacher failed: {err}");
        } else {
            println!("DAO index: initial refresh from dao-cacher complete");
        }
        if let Err(err) = self.refresh_dao_index_from_chain() {
            println!("DAO index: initial refresh from chain failed: {err}");
        } else {
            println!("DAO index: initial refresh from chain complete");
        }
        add_to_homepage("HYPR DAO", Some(ICON), Some("/"), None);
        self.node_id = our().node.clone();
        if let Err(err) = self.refresh_lock_state(None) {
            println!("Failed to load lock details: {}", err);
            self.last_error = Some(err);
        }
    }

    #[http]
    async fn get_lock_status(&self) -> Result<LockStatusPayload, String> {
        Ok(self.current_status())
    }

    #[http]
    async fn get_lock_status_for(&mut self, address: String) -> Result<LockStatusPayload, String> {
        let parsed = EthAddress::from_str(&address)
            .map_err(|_| "invalid owner address provided".to_string())?;
        // Update the tracked owner to the requested address and refresh using existing logic.
        self.owner_address = Some(format_address(parsed));
        self.refresh_lock_state(Some(parsed))?;
        Ok(self.current_status())
    }

    #[http]
    async fn refresh_lock_status(&mut self) -> Result<LockStatusPayload, String> {
        match self.refresh_lock_state(None) {
            Ok(_) => Ok(self.current_status()),
            Err(err) => {
                self.last_error = Some(err.clone());
                Err(err)
            }
        }
    }

    #[http]
    async fn refresh_lock_status_for(
        &mut self,
        address: String,
    ) -> Result<LockStatusPayload, String> {
        let parsed = EthAddress::from_str(&address)
            .map_err(|_| "invalid owner address provided".to_string())?;
        self.owner_address = Some(format_address(parsed));
        match self.refresh_lock_state(Some(parsed)) {
            Ok(_) => Ok(self.current_status()),
            Err(err) => {
                self.last_error = Some(err.clone());
                Err(err)
            }
        }
    }

    #[http]
    async fn get_proposal(&self, proposal_id: String) -> Result<ProposalView, String> {
        if let Some(idx) = &self.dao_index {
            if let Some(entry) = idx.proposals.get(&proposal_id) {
                let queued_at = entry.queued_at.unwrap_or(0);
                let execute_after = entry.execute_after.or(entry.eta).unwrap_or(0);
                let mut min_delay_seconds = 0;
                if execute_after > 0 && queued_at > 0 && execute_after >= queued_at {
                    min_delay_seconds = execute_after.saturating_sub(queued_at);
                }
                return Ok(ProposalView {
                    proposal_id: entry.proposal_id.clone(),
                    proposer: entry.proposer.clone(),
                    description: entry.description.clone(),
                    start_block: entry.start_block,
                    end_block: entry.end_block,
                    state: entry.state.unwrap_or(u8::MAX),
                    queued_at,
                    execute_after,
                    min_delay_seconds,
                    executed_at: entry.executed_at.unwrap_or(0),
                });
            }
        }
        Err("proposal not found in index".to_string())
    }

    #[http]
    async fn get_votes(&self, proposal_id: String) -> Result<Vec<VoteView>, String> {
        if let Some(idx) = &self.dao_index {
            if let Some(v) = idx.votes.get(&proposal_id) {
                return Ok(v.clone());
            }
        }
        Ok(Vec::new())
    }

    #[http]
    async fn quorum_progress(&mut self, proposal_id: String) -> Result<QuorumProgress, String> {
        if let Some(idx) = &self.dao_index {
            if let Some(q) = idx.quorum.get(&proposal_id) {
                return Ok(q.clone());
            }
        }
        Ok(QuorumProgress {
            percent: 0.0,
            bps: 0,
            counted: "0".to_string(),
            required: "0".to_string(),
        })
    }

    #[http]
    async fn list_proposals(&mut self) -> Result<Vec<ProposalView>, String> {
        if let Some(idx) = &self.dao_index {
            println!(
                "list_proposals: current DAO checkpoint {}",
                idx.last_block
            );
        }
        let now_ts = current_unix_timestamp();
        let should_fallback_to_cache = self
            .last_chain_sync_ts
            .map(|last| now_ts.saturating_sub(last) > CHAIN_REFRESH_CACHE_FALLBACK_SECONDS)
            .unwrap_or(true);
        let mut updated_self = self.clone();
        if should_fallback_to_cache {
            println!("DAO index: refresh using dao-cacher due to stale chain sync");
            if let Err(e) = updated_self.refresh_dao_index_from_cacher() {
                println!("DAO index: refresh from dao-cacher failed: {e}");
            }
        }
        if let Err(e) = updated_self.refresh_dao_index_from_chain() {
            println!("DAO index: refresh from chain failed: {e}");
        }
        // Sync any updated checkpoint back to self so subsequent calls start from the latest.
        self.dao_index = updated_self.dao_index.clone();
        self.last_chain_sync_ts = updated_self.last_chain_sync_ts;
        let mut ids_to_rehydrate: Vec<String> = Vec::new();
        if let Some(idx) = &self.dao_index {
            let hydrate_all = idx.proposals_indexed == 0 && !idx.proposals.is_empty();
            if hydrate_all {
                ids_to_rehydrate.extend(idx.proposals.keys().cloned());
            } else {
                let current_block = idx.last_block;
                let current_ts = Self::dao_client()
                    .ok()
                    .and_then(|dao| dao.block_timestamp(current_block).ok())
                    .unwrap_or(0);
                for (id, entry) in &idx.proposals {
                    let state_val = entry.state.unwrap_or(u8::MAX);
                    let after_start = if current_ts > 0 {
                        entry.start_block <= current_ts
                    } else {
                        entry.start_block <= current_block
                    };
                    let after_end = if current_ts > 0 {
                        entry.end_block <= current_ts
                    } else {
                        entry.end_block <= current_block
                    };
                    if (state_val == 0 && after_start) || (state_val == 1 && after_end) {
                        ids_to_rehydrate.push(id.clone());
                    }
                }
            }
        }
        if !ids_to_rehydrate.is_empty() {
            let _ = self.hydrate_index_entries(&ids_to_rehydrate);
        }
        let mut proposals = Vec::new();
        if let Some(idx) = &self.dao_index {
            let mut ids: Vec<_> = idx.proposals.keys().cloned().collect();
            ids.sort_by(|a, b| {
                let sa = idx.proposals.get(a).map(|e| e.start_block).unwrap_or(0);
                let sb = idx.proposals.get(b).map(|e| e.start_block).unwrap_or(0);
                sb.cmp(&sa)
            });
            for id in &ids {
                let Some(entry) = idx.proposals.get(id) else { continue };
                let state_val = entry.state.unwrap_or(u8::MAX);
                let queued_at: u64 = entry.queued_at.unwrap_or(0);
                let execute_after: u64 =
                    entry.execute_after.or(entry.eta).unwrap_or(0);
                let mut min_delay_seconds: u64 = 0;
                let executed_at: u64 = entry.executed_at.unwrap_or(0);

                if execute_after > 0 && queued_at > 0 && execute_after >= queued_at {
                    min_delay_seconds = execute_after.saturating_sub(queued_at);
                }

                proposals.push(ProposalView {
                    proposal_id: entry.proposal_id.clone(),
                    proposer: entry.proposer.clone(),
                    description: entry.description.clone(),
                    start_block: entry.start_block,
                    end_block: entry.end_block,
                    state: state_val,
                    queued_at,
                    execute_after,
                    min_delay_seconds,
                    executed_at,
                });
            }
            println!(
                "list_proposals: index summary -> proposals {}, votes {}, quorum {}, ids {:?}",
                idx.proposals.len(),
                idx.votes.len(),
                idx.quorum.len(),
                ids
            );
        } else {
            println!("list_proposals: no dao_index present");
        }
        println!("list_proposals: returning {} proposals", proposals.len());
        Ok(proposals)
    }

    #[http]
    async fn has_voted(&self, proposal_id: String, voter: String) -> Result<bool, String> {
        if let Some(idx) = &self.dao_index {
            if let Some(votes) = idx.votes.get(&proposal_id) {
                let target = voter.to_lowercase();
                return Ok(votes.iter().any(|v| v.voter.to_lowercase() == target));
            }
        }
        Ok(false)
    }

    #[http]
    async fn get_vote_confirmations(&self, voter: String) -> Result<Vec<String>, String> {
        let key = confirmed_votes_key(&voter)?;
        Ok(self.confirmed_votes.get(&key).cloned().unwrap_or_default())
    }

    #[http]
    async fn record_vote_confirmation(
        &mut self,
        proposal_id: String,
        voter: String,
    ) -> Result<(), String> {
        let key = confirmed_votes_key(&voter)?;
        let entry = self.confirmed_votes.entry(key).or_default();
        if !entry.contains(&proposal_id) {
            entry.push(proposal_id);
            self.save_checkpoint()?;
        }
        Ok(())
    }

    #[http]
    async fn has_voting_power(&self, proposal_id: String, voter: String) -> Result<VotingPowerAtSnapshot, String> {
        let dao = Self::dao_client()?;
        let parsed_id = parse_u256(&proposal_id)?;
        let parsed_voter = EthAddress::from_str(&voter)
            .map_err(|_| "invalid voter address provided".to_string())?;
        let has_power = match dao.has_power_at_snapshot(parsed_id, parsed_voter) {
            Ok(val) => val,
            Err(e) => {
                // If voting power cannot be determined (e.g., NoRpcForChain), assume true to avoid false negatives.
                if e.contains("NoRpcForChain") {
                    println!(
                        "has_voting_power: NoRpcForChain for proposal {}, voter {}, chain {}, treating as true",
                        proposal_id, voter, LOCAL_CHAIN_ID
                    );
                    true
                } else {
                    println!(
                        "has_voting_power error for proposal {} voter {} on chain {}: {}",
                        proposal_id, voter, LOCAL_CHAIN_ID, e
                    );
                    return Err(format!("unable to check voting power: {e}"));
                }
            }
        };
        Ok(VotingPowerAtSnapshot { has_power })
    }

    #[http]
    async fn acknowledge_lock_modal(&mut self) -> Result<(), String> {
        self.lock_modal_seen = true;
        Ok(())
    }

    #[http]
    async fn lookup_name(&self, namehash: String) -> Result<Option<String>, String> {
        if namehash == ZERO_NAMEHASH {
            return Ok(Some("".to_string()));
        }
        Ok(resolve_name_for_hash(&namehash))
    }
}

impl HyprDaoState {
    fn current_status(&self) -> LockStatusPayload {
        LockStatusPayload {
            node_id: self.node_id.clone(),
            owner_address: self.owner_address.clone(),
            lock_details: self.lock_details.clone(),
            hypr_owned: self.hypr_owned.clone(),
            hypr_approved: self.hypr_approved.clone(),
            tokeregistry_allowance: self.tokeregistry_allowance.clone(),
            hypr_token_address: self.hypr_token_address.clone(),
            available_to_bind: self.available_to_bind.clone(),
            bindings: self.bindings.clone(),
            error: self.last_error.clone(),
            lock_modal_seen: self.lock_modal_seen,
            chain_id: LOCAL_CHAIN_ID,
            min_lock_duration_seconds: MIN_LOCK_DURATION_SECONDS,
        }
    }

    fn refresh_lock_state(&mut self, owner_override: Option<EthAddress>) -> Result<(), String> {
        // If an override was provided (e.g., get_lock_status_for), use it; otherwise rely on the cached owner.
        let owner = if let Some(addr) = owner_override {
            addr
        } else {
            let cached = self
                .owner_address
                .clone()
                .ok_or_else(|| "owner address not set; connect a wallet".to_string())?;
            EthAddress::from_str(&cached).map_err(|_| "cached owner address invalid".to_string())?
        };
        let bindings = Self::bindings_client()?;
        let details = bindings
            .get_lock_details(owner)
            .map_err(|err| format!("unable to read lock details: {err:?}"))?;
        let hypr_address = bindings
            .get_hypr_address()
            .map_err(|err| format!("unable to read HYPR token address: {err:?}"))?;
        let available_hypr = bindings
            .get_hypr_balance(owner)
            .map_err(|err| format!("unable to read HYPR balance: {err:?}"))?;
        let hypr_allowance = bindings
            .get_hypr_allowance(owner)
            .map_err(|err| format!("unable to read HYPR allowance: {err:?}"))?;
        let approved = if hypr_allowance < available_hypr {
            hypr_allowance
        } else {
            available_hypr
        };

        self.owner_address = Some(format_address(owner));
        self.lock_details = Some(LockDetailsView::from(details));
        let bind_hashes = bindings
            .get_user_binds(owner)
            .map_err(|err| format!("unable to read registrations: {err:?}"))?;
        let mut bind_views = Vec::new();
        self.available_to_bind = None;
        for hash in bind_hashes {
            if let Ok(details) = bindings.get_registration_details_by_hash(hash, owner) {
                let namehash_hex = format_namehash(hash);
                let resolved_name = resolve_name_for_hash(&namehash_hex);
                if is_default_binding(hash) {
                    self.available_to_bind = Some(BalanceView::from(details.amount));
                } else {
                    bind_views.push(BindDetailsView::from_registration(
                        namehash_hex,
                        details,
                        resolved_name,
                    ));
                }
            }
        }

        self.hypr_owned = Some(BalanceView::from(available_hypr));
        self.hypr_approved = Some(BalanceView::from(approved));
        self.tokeregistry_allowance = Some(BalanceView::from(hypr_allowance));
        self.hypr_token_address = Some(format_address(hypr_address));
        self.bindings = bind_views;
        if self.available_to_bind.is_none() {
            self.available_to_bind = Some(BalanceView::from(U256::ZERO));
        }
        self.last_error = None;

        println!(
            "Lock details for {} ({:?}) refreshed",
            self.node_id, self.owner_address
        );
        Ok(())
    }

    fn bindings_client() -> Result<Bindings, String> {
        let provider = Provider::new(LOCAL_CHAIN_ID, 30);
        let address = EthAddress::from_str(LOCAL_TOKEN_REGISTRY)
            .map_err(|_| "invalid proxy address".to_string())?;
        Ok(Bindings::new(provider, address))
    }

    fn dao_client() -> Result<DaoContracts, String> {
        let provider = Provider::new(LOCAL_CHAIN_ID, 30);
        let timelock =
            EthAddress::from_str(LOCAL_TIMELOCK).map_err(|_| "invalid timelock address".to_string())?;
        let governor =
            EthAddress::from_str(LOCAL_GOVERNOR).map_err(|_| "invalid governor address".to_string())?;
        let votes_token = EthAddress::from_str(LOCAL_VOTES_TOKEN)
            .map_err(|_| "invalid votes token address".to_string())?;
        Ok(DaoContracts {
            provider,
            timelock,
            governor,
            votes_token,
        })
    }
}

#[allow(dead_code)]
fn fetch_votes(dao: &DaoContracts, proposal_id: U256) -> Result<Vec<VoteView>, String> {
    // Fetch all votes from earliest for this governor; proposalId is not indexed, so filter post-decode.
    let topic0 = VoteCast::SIGNATURE_HASH;
    let filter = EthFilter::new()
        .address(dao.governor)
        .event_signature(B256::from(topic0))
        .from_block(BlockNumberOrTag::from(DAO_FIRST_BLOCK));
    let logs = dao
        .provider
        .get_logs(&filter)
        .map_err(|err| format!("unable to fetch vote logs: {err:?}"))?;
    let mut out = Vec::new();
    for log in logs {
        let prim_log = log.inner.clone();
        if let Ok(decoded) = VoteCast::decode_log(&prim_log, true) {
            if decoded.proposalId == proposal_id {
                out.push(VoteView {
                    voter: format_address(decoded.voter),
                    support: decoded.support,
                    weight: decoded.weight.to_string(),
                    reason: decoded.reason.clone(),
                });
            }
        }
    }
    Ok(out)
}

#[allow(dead_code)]
struct ProposalQueuedEvent {
    proposal_id: U256,
    eta: U256,
    block_number: u64,
}

#[allow(dead_code)]
fn fetch_proposals_queued(
    dao: &DaoContracts,
    from_block: BlockNumberOrTag,
    to_block: Option<BlockNumberOrTag>,
) -> Result<Vec<ProposalQueuedEvent>, String> {
    let mut filter = EthFilter::new()
        .address(dao.governor)
        .event_signature(B256::from(ProposalQueued::SIGNATURE_HASH))
        .from_block(from_block);
    if let Some(to) = to_block {
        filter = filter.to_block(to);
    }
    let logs = dao
        .provider
        .get_logs(&filter)
        .map_err(|err| format!("unable to fetch proposal queue logs: {err:?}"))?;
    let mut out_events = Vec::new();
    for log in logs {
        let prim_log = log.inner.clone();
        if let Ok(decoded) = ProposalQueued::decode_log(&prim_log, true) {
            let block_number = log.block_number.unwrap_or_default();
            out_events.push(ProposalQueuedEvent {
                proposal_id: decoded.proposalId,
                eta: decoded.eta,
                block_number,
            });
        }
    }
    Ok(out_events)
}

#[allow(dead_code)]
fn check_has_voted(
    dao: &DaoContracts,
    proposal_id: U256,
    voter: EthAddress,
) -> Result<bool, String> {
    let call = GovernorHasVoted::hasVotedCall {
        proposalId: proposal_id,
        account: voter,
    };
    let tx_req = TransactionRequest::default()
        .to(dao.governor)
        .input(TransactionInput::new(Bytes::from(call.abi_encode())));
    let res_bytes = dao
        .provider
        .call(tx_req, None)
        .map_err(|err| format!("unable to call hasVoted: {err:?}"))?;
    GovernorHasVoted::hasVotedCall::abi_decode_returns(&res_bytes, false)
        .map(|ret| ret._0)
        .map_err(|_| "malformed hasVoted response".to_string())
}

fn decode_cacher_logs(
    json: &str,
) -> (
    usize,
    u64,
    u64,
    HashMap<String, ProposalIndexEntry>,
    HashMap<String, Vec<VoteView>>,
) {
    #[derive(Deserialize)]
    struct MetaStub {
        #[serde(rename = "fromBlock")]
        from_block: String,
        #[serde(rename = "toBlock")]
        to_block: String,
    }
    #[derive(Deserialize)]
    struct CacheStub {
        metadata: MetaStub,
        logs: Vec<hyperware_process_lib::eth::Log>,
    }

    let mut proposals: HashMap<String, ProposalIndexEntry> = HashMap::new();
    let mut votes: HashMap<String, Vec<VoteView>> = HashMap::new();
    let mut log_count = 0usize;
    let mut span_from = u64::MAX;
    let mut span_to = 0u64;
    let mut ordered_logs: Vec<hyperware_process_lib::eth::Log> = Vec::new();

    if let Ok(caches) = serde_json::from_str::<Vec<CacheStub>>(json) {
        for cache in caches {
            if let Ok(fb) = cache.metadata.from_block.parse::<u64>() {
                span_from = span_from.min(fb);
            }
            if let Ok(tb) = cache.metadata.to_block.parse::<u64>() {
                span_to = span_to.max(tb);
            }
            ordered_logs.extend(cache.logs);
        }
    }

    ordered_logs.sort_by(|a, b| {
        let a_block = (a.block_number.is_none(), a.block_number.unwrap_or(0));
        let b_block = (b.block_number.is_none(), b.block_number.unwrap_or(0));
        let a_tx = (a.transaction_index.is_none(), a.transaction_index.unwrap_or(0));
        let b_tx = (b.transaction_index.is_none(), b.transaction_index.unwrap_or(0));
        let a_log = (a.log_index.is_none(), a.log_index.unwrap_or(0));
        let b_log = (b.log_index.is_none(), b.log_index.unwrap_or(0));
        a_block
            .cmp(&b_block)
            .then_with(|| a_tx.cmp(&b_tx))
            .then_with(|| a_log.cmp(&b_log))
    });

    for log in ordered_logs {
        log_count += 1;
        let prim = log.inner.clone();
        if let Ok(decoded) = HyperwareGovernor::ProposalCreated::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.proposer = format_address(decoded.proposer);
            entry.description = decoded.description.clone();
            entry.start_block = u256_to_u64(&decoded.startBlock);
            entry.end_block = u256_to_u64(&decoded.endBlock);
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::ProposalQueued::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.queued_block = log.block_number;
            entry.execute_after = Some(u256_to_u64(&decoded.eta));
            entry.eta = Some(u256_to_u64(&decoded.eta));
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::ProposalExecuted::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.executed_block = log.block_number;
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::ProposalCanceled::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.state = Some(2);
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::VoteCast::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            proposals.entry(id_str.clone()).or_default().proposal_id = id_str.clone();
            votes.entry(id_str.clone()).or_default().push(VoteView {
                voter: format_address(decoded.voter),
                support: decoded.support,
                weight: decoded.weight.to_string(),
                reason: decoded.reason.clone(),
            });
        }
    }

    (log_count, span_from, span_to, proposals, votes)
}

fn fetch_chain_logs(
    dao: &DaoContracts,
    from_block: u64,
    to_block: u64,
) -> Result<
    (
        usize,
        u64,
        u64,
        HashMap<String, ProposalIndexEntry>,
        HashMap<String, Vec<VoteView>>,
    ),
    String,
> {
    let mut logs: Vec<hyperware_process_lib::eth::Log> = Vec::new();
    let to_tag = BlockNumberOrTag::Number(to_block);
    let mut fetch = |sig: B256| -> Result<(), String> {
        let mut filter = EthFilter::new()
            .address(dao.governor)
            .event_signature(sig)
            .from_block(BlockNumberOrTag::Number(from_block));
        filter = filter.to_block(to_tag.clone());
        let mut entries = dao
            .provider
            .get_logs(&filter)
            .map_err(|err| format!("unable to fetch chain logs: {err:?}"))?;
        logs.append(&mut entries);
        Ok(())
    };
    fetch(B256::from(HyperwareGovernor::ProposalCreated::SIGNATURE_HASH))?;
    fetch(B256::from(HyperwareGovernor::ProposalQueued::SIGNATURE_HASH))?;
    fetch(B256::from(HyperwareGovernor::ProposalExecuted::SIGNATURE_HASH))?;
    fetch(B256::from(HyperwareGovernor::ProposalCanceled::SIGNATURE_HASH))?;
    fetch(B256::from(HyperwareGovernor::VoteCast::SIGNATURE_HASH))?;

    let log_count = logs.len();
    let mut span_from = if log_count > 0 { u64::MAX } else { from_block };
    let mut span_to = if log_count > 0 { 0u64 } else { to_block };
    for log in &logs {
        if let Some(block) = log.block_number {
            span_from = span_from.min(block);
            span_to = span_to.max(block);
        }
    }
    logs.sort_by(|a, b| {
        let a_block = (a.block_number.is_none(), a.block_number.unwrap_or(0));
        let b_block = (b.block_number.is_none(), b.block_number.unwrap_or(0));
        let a_tx = (a.transaction_index.is_none(), a.transaction_index.unwrap_or(0));
        let b_tx = (b.transaction_index.is_none(), b.transaction_index.unwrap_or(0));
        let a_log = (a.log_index.is_none(), a.log_index.unwrap_or(0));
        let b_log = (b.log_index.is_none(), b.log_index.unwrap_or(0));
        a_block
            .cmp(&b_block)
            .then_with(|| a_tx.cmp(&b_tx))
            .then_with(|| a_log.cmp(&b_log))
    });

    let mut proposals: HashMap<String, ProposalIndexEntry> = HashMap::new();
    let mut votes: HashMap<String, Vec<VoteView>> = HashMap::new();
    for log in logs {
        let prim = log.inner.clone();
        if let Ok(decoded) = HyperwareGovernor::ProposalCreated::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.proposer = format_address(decoded.proposer);
            entry.description = decoded.description.clone();
            entry.start_block = u256_to_u64(&decoded.startBlock);
            entry.end_block = u256_to_u64(&decoded.endBlock);
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::ProposalQueued::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.queued_block = log.block_number;
            entry.execute_after = Some(u256_to_u64(&decoded.eta));
            entry.eta = Some(u256_to_u64(&decoded.eta));
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::ProposalExecuted::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.executed_block = log.block_number;
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::ProposalCanceled::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            let entry = proposals.entry(id_str.clone()).or_default();
            entry.proposal_id = id_str;
            entry.state = Some(2);
            continue;
        }
        if let Ok(decoded) = HyperwareGovernor::VoteCast::decode_log(&prim, true) {
            let id_str = decoded.proposalId.to_string();
            proposals.entry(id_str.clone()).or_default().proposal_id = id_str.clone();
            votes.entry(id_str.clone()).or_default().push(VoteView {
                voter: format_address(decoded.voter),
                support: decoded.support,
                weight: decoded.weight.to_string(),
                reason: decoded.reason.clone(),
            });
        }
    }
    Ok((log_count, span_from, span_to, proposals, votes))
}

fn merge_proposal_entry(target: &mut ProposalIndexEntry, incoming: ProposalIndexEntry) {
    // Preserve first-seen values for immutable fields; only state updates overwrite.
    if target.proposal_id.is_empty() && !incoming.proposal_id.is_empty() {
        target.proposal_id = incoming.proposal_id;
    }
    if target.proposer.is_empty() && !incoming.proposer.is_empty() {
        target.proposer = incoming.proposer;
    }
    if target.description.is_empty() && !incoming.description.is_empty() {
        target.description = incoming.description;
    }
    if target.start_block == 0 && incoming.start_block != 0 {
        target.start_block = incoming.start_block;
    }
    if target.end_block == 0 && incoming.end_block != 0 {
        target.end_block = incoming.end_block;
    }
    if target.queued_block.is_none() && incoming.queued_block.is_some() {
        target.queued_block = incoming.queued_block;
    }
    if target.execute_after.is_none() && incoming.execute_after.is_some() {
        target.execute_after = incoming.execute_after;
    }
    if target.executed_block.is_none() && incoming.executed_block.is_some() {
        target.executed_block = incoming.executed_block;
    }
    if incoming.state.is_some() {
        target.state = incoming.state;
    }
    if target.eta.is_none() && incoming.eta.is_some() {
        target.eta = incoming.eta;
    }
    if target.queued_at.is_none() && incoming.queued_at.is_some() {
        target.queued_at = incoming.queued_at;
    }
    if target.executed_at.is_none() && incoming.executed_at.is_some() {
        target.executed_at = incoming.executed_at;
    }
}

impl HyprDaoState {
    fn hydrate_index_entries(&mut self, ids: &[String]) -> Result<(), String> {
        let dao = HyprDaoState::dao_client()?;
        for id in ids {
            let Ok(parsed_id) = parse_u256(id) else {
                continue;
            };
            if let Some(idx) = &mut self.dao_index {
                if let Some(entry) = idx.proposals.get_mut(id) {
                    entry.state = Some(dao.proposal_state(parsed_id).unwrap_or(u8::MAX));
                    if entry.eta.is_none() {
                        if let Ok(eta) = dao.proposal_eta(parsed_id) {
                            entry.eta = Some(u256_to_u64(&eta));
                            entry.execute_after = entry.eta;
                        }
                    }
                    if entry.execute_after.is_none() {
                        entry.execute_after = entry.eta;
                    }
                    if entry.queued_at.is_none() {
                        if let Some(qb) = entry.queued_block {
                            if let Ok(ts) = dao.block_timestamp(qb) {
                                entry.queued_at = Some(ts);
                            }
                        }
                    }
                    if entry.executed_at.is_none() {
                        if let Some(eb) = entry.executed_block {
                            if let Ok(ts) = dao.block_timestamp(eb) {
                                entry.executed_at = Some(ts);
                            }
                        }
                    }
                    // Skip quorum calc for Pending (0) and Canceled (2) to avoid revert/error states.
                    if entry.state == Some(0) || entry.state == Some(2) {
                        continue;
                    }
                    match dao.quorum_progress_bps(parsed_id) {
                        Ok((bps, counted, required)) => {
                            let percent = bps as f64 / 100.0;
                            let bps_u64: u64 = bps.try_into().unwrap_or(u64::MAX);
                            idx.quorum.insert(
                                id.clone(),
                                QuorumProgress {
                                    percent,
                                    bps: bps_u64,
                                    counted: counted.to_string(),
                                    required: required.to_string(),
                                },
                            );
                        }
                        Err(err) => {
                            if err.contains("NoRpcForChain") || err.contains("execution reverted") {
                                idx.quorum.insert(
                                    id.clone(),
                                    QuorumProgress {
                                        percent: 0.0,
                                        bps: 0,
                                        counted: "0".to_string(),
                                        required: "0".to_string(),
                                    },
                                );
                            } else {
                                println!(
                                    "quorum_progress hydrate error for proposal {} on chain {}: {}",
                                    id, LOCAL_CHAIN_ID, err
                                );
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}


impl From<OnchainLockDetails> for LockDetailsView {
    fn from(details: OnchainLockDetails) -> Self {
        LockDetailsView {
            amount_raw_wei: details.amount.to_string(),
            amount_formatted_hypr: format_hypr_amount(&details.amount),
            unlock_timestamp: u256_to_u64(&details.end_time),
            remaining_seconds: u256_to_u64(&details.remaining_time),
        }
    }
}

impl From<U256> for BalanceView {
    fn from(amount: U256) -> Self {
        BalanceView {
            amount_raw_wei: amount.to_string(),
            amount_formatted_hypr: format_hypr_amount(&amount),
        }
    }
}

fn format_hypr_amount(amount: &U256) -> String {
    if amount.is_zero() {
        return "0 HYPR".to_string();
    }

    const DECIMALS: usize = 18;
    let digits = amount.to_string();
    if digits.len() <= DECIMALS {
        let mut frac = digits;
        while frac.len() < DECIMALS {
            frac.insert(0, '0');
        }
        let frac = frac.trim_end_matches('0');
        if frac.is_empty() {
            "0 HYPR".to_string()
        } else {
            format!("0.{frac} HYPR")
        }
    } else {
        let split = digits.len() - DECIMALS;
        let whole = &digits[..split];
        let frac = digits[split..].trim_end_matches('0').to_string();
        if frac.is_empty() {
            format!("{whole} HYPR")
        } else {
            format!("{whole}.{frac} HYPR")
        }
    }
}

fn current_unix_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn u256_to_u64(value: &U256) -> u64 {
    value.try_into().unwrap_or(u64::MAX)
}

fn parse_u256(value: &str) -> Result<U256, String> {
    if let Some(stripped) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        U256::from_str_radix(stripped, 16).map_err(|_| "invalid hex proposal id".to_string())
    } else {
        U256::from_str(value).map_err(|_| "invalid decimal proposal id".to_string())
    }
}

fn format_namehash(hash: FixedBytes<32>) -> String {
    format!("{hash:#x}")
}

fn format_address(address: EthAddress) -> String {
    format!("{address:#x}")
}

fn resolve_name_for_hash(namehash: &str) -> Option<String> {
    let request = IndexerRequest::NamehashToName(NamehashToNameRequest {
        hash: namehash.to_string(),
        block: 0,
    });
    let response = match Request::to(("our", "hns-indexer", "hns-indexer", "sys"))
        .body(request)
        .send_and_await_response(HNS_INDEXER_TIMEOUT_S)
    {
        Ok(Ok(message)) => message,
        _ => return None,
    };
    let Message::Response { body, .. } = response else {
        return None;
    };
    match body.try_into() {
        Ok(IndexerResponse::Name(name)) => name,
        _ => None,
    }
}

impl BindDetailsView {
    fn from_registration(
        namehash: String,
        details: RegistrationDetails,
        name: Option<String>,
    ) -> Self {
        BindDetailsView {
            namehash,
            name,
            amount_raw_wei: details.amount.to_string(),
            amount_formatted_hypr: format_hypr_amount(&details.amount),
            unlock_timestamp: u256_to_u64(&details.end_time),
            remaining_seconds: u256_to_u64(&details.remaining_time),
        }
    }
}

fn is_default_binding(hash: FixedBytes<32>) -> bool {
    hash == FixedBytes::<32>::ZERO
}
