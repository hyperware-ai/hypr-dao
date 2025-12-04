use alloy_primitives::{Address as EthAddress, FixedBytes, U256};
use hyperprocess_macro::hyperprocess;
use hyperware_process_lib::{
    bindings::{Bindings, LockDetails as OnchainLockDetails, RegistrationDetails},
    eth::Provider,
    homepage::add_to_homepage,
    hypermap, our, println, Message, Request,
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

const ICON: &str = include_str!("./icon");
#[cfg(feature = "simulation-mode")]
const LOCAL_CHAIN_ID: u64 = 31337;
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_CHAIN_ID: u64 = 8453;

#[cfg(feature = "simulation-mode")]
const LOCAL_TOKEN_REGISTRY: &str = "0x0000000000e8d224B902632757d5dbc51a451456";
#[cfg(not(feature = "simulation-mode"))]
const LOCAL_TOKEN_REGISTRY: &str = "0x0000000000e8d224B902632757d5dbc51a451456";

#[cfg(feature = "simulation-mode")]
const SIMULATION_OWNER: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
#[cfg(not(feature = "simulation-mode"))]
const SIMULATION_OWNER: &str = "0x0000000000000000000000000000000000000000";

#[cfg(feature = "simulation-mode")]
const MIN_LOCK_DURATION_SECONDS: u64 = 4 * 60;
#[cfg(not(feature = "simulation-mode"))]
const MIN_LOCK_DURATION_SECONDS: u64 = 4 * 7 * 24 * 60 * 60;
const HNS_INDEXER_TIMEOUT_S: u64 = 5;
const ZERO_NAMEHASH: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

mod hns_indexer_api {
    wit_bindgen::generate!({
        path: "../api/hns-indexer-wit/hns-indexer:sys-v0.wit",
        world: "hns-indexer-sys-v0",
        generate_unused_types: true,
        additional_derives: [serde::Deserialize, serde::Serialize, process_macros::SerdeJsonInto],
    });
}

use hns_indexer_api::hyperware::process::hns_indexer::{
    IndexerRequest, IndexerResponse, NamehashToNameRequest,
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

#[derive(Serialize, Deserialize, Debug, Clone)]
struct HyprDaoState {
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

impl Default for HyprDaoState {
    fn default() -> Self {
        Self {
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
        }
    }
}

#[hyperprocess(
    name = "HYPR DAO",
    ui = Some(hyperware_process_lib::http::server::HttpBindingConfig::default()),
    endpoints = vec![hyperware_process_lib::hyperapp::Binding::Http {
        path: "/api",
        config: hyperware_process_lib::http::server::HttpBindingConfig::default(),
    }],
    save_config = hyperware_process_lib::hyperapp::SaveOptions::EveryMessage,
    wit_world = "hypr-dao-ware-dot-hypr-v0"
)]
impl HyprDaoState {
    #[init]
    async fn initialize(&mut self) {
        add_to_homepage("HYPR DAO", Some(ICON), Some("/"), None);
        self.node_id = our().node.clone();
        if let Err(err) = self.refresh_lock_state() {
            println!("Failed to load lock details: {}", err);
            self.last_error = Some(err);
        }
    }

    #[http]
    async fn get_lock_status(&self) -> Result<LockStatusPayload, String> {
        Ok(self.current_status())
    }

    #[http]
    async fn refresh_lock_status(&mut self) -> Result<LockStatusPayload, String> {
        match self.refresh_lock_state() {
            Ok(_) => Ok(self.current_status()),
            Err(err) => {
                self.last_error = Some(err.clone());
                Err(err)
            }
        }
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

    fn refresh_lock_state(&mut self) -> Result<(), String> {
        // For production, always re-resolve the owner to avoid stale cache; simulation-mode keeps the existing shortcut.
        #[cfg(feature = "simulation-mode")]
        let owner = match self.owner_address.clone() {
            Some(addr) if !addr.is_empty() => EthAddress::from_str(&addr)
                .map_err(|_| "cached owner address invalid".to_string())?,
            _ => {
                let resolved = Self::resolve_owner_address()?;
                self.owner_address = Some(resolved.to_string());
                resolved
            }
        };
        #[cfg(not(feature = "simulation-mode"))]
        let owner = {
            let resolved = Self::resolve_owner_address()?;
            self.owner_address = Some(resolved.to_string());
            resolved
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

        self.owner_address = Some(owner.to_string());
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

    fn resolve_owner_address() -> Result<EthAddress, String> {
        let node_name = our().node.clone();
        let hypermap = hypermap::Hypermap::default(5);
        match hypermap.get(&node_name) {
            Ok((_, owner, _)) => Ok(owner),
            Err(err) => {
                if Self::is_simulation_mode() {
                    return EthAddress::from_str(SIMULATION_OWNER)
                        .map_err(|_| "invalid simulation owner address constant".to_string());
                }
                Err(format!("failed to resolve owner from hypermap: {err:?}"))
            }
        }
    }

    fn bindings_client() -> Result<Bindings, String> {
        let provider = Provider::new(LOCAL_CHAIN_ID, 30);
        let address = EthAddress::from_str(LOCAL_TOKEN_REGISTRY)
            .map_err(|_| "invalid proxy address".to_string())?;
        Ok(Bindings::new(provider, address))
    }

    fn is_simulation_mode() -> bool {
        LOCAL_CHAIN_ID == 31337
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

fn u256_to_u64(value: &U256) -> u64 {
    value.try_into().unwrap_or(u64::MAX)
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
