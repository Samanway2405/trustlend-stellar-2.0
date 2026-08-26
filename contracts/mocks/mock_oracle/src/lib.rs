#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

/// Price precision: 7 decimal places (matching XLM stroops convention).
/// 10_000_000 = 1.0 in base units.
const PRICE_PRECISION: i128 = 10_000_000;

#[contracttype]
enum DataKey {
    Admin,
    Price(Address),
    TwapPrice(Address),
}

#[contract]
pub struct MockOracleContract;

#[contractimpl]
impl MockOracleContract {
    /// Initialize the mock oracle with an admin address.
    /// Panics if already initialized.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Set a single price for an asset.
    ///
    /// `price` is in PRICE_PRECISION units (10^7 = 1.0).
    /// Panics if caller is not admin or price is non-positive.
    pub fn set_price(env: Env, caller: Address, asset: Address, price: i128) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if price <= 0 {
            panic!("Price must be positive");
        }

        let prices = soroban_sdk::vec![&env, price];
        env.storage()
            .instance()
            .set(&DataKey::Price(asset), &prices);
    }

    /// Bulk-set price samples for an asset.
    ///
    /// Mirrors `lending::set_asset_oracle_prices`. The median of the samples
    /// is used as the effective price.
    /// Panics if caller is not admin, samples are empty, etc.
    pub fn set_prices(env: Env, caller: Address, asset: Address, prices: Vec<i128>) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if prices.is_empty() {
            panic!("At least one oracle price sample is required");
        }

        env.storage()
            .instance()
            .set(&DataKey::Price(asset), &prices);
    }

    /// Set a TWAP fallback price for an asset.
    ///
    /// Mirrors `lending::set_asset_twap_price`.
    pub fn set_twap_price(env: Env, caller: Address, asset: Address, price: i128) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if price <= 0 {
            panic!("TWAP price must be positive");
        }

        env.storage()
            .instance()
            .set(&DataKey::TwapPrice(asset), &price);
    }

    /// Get the median price for an asset.
    ///
    /// If multiple samples exist, returns the median (matching lending's
    /// `median_price` helper). If only one sample exists, returns it directly.
    /// Panics if no price samples are set for the asset.
    pub fn get_price(env: Env, asset: Address) -> i128 {
        let prices: Vec<i128> = env
            .storage()
            .instance()
            .get(&DataKey::Price(asset))
            .unwrap_or(Vec::new(&env));

        if prices.is_empty() {
            panic!("No price set for asset");
        }

        Self::median_price(&env, &prices)
    }

    /// Get raw price samples for an asset.
    pub fn get_prices(env: Env, asset: Address) -> Vec<i128> {
        env.storage()
            .instance()
            .get(&DataKey::Price(asset))
            .unwrap_or(Vec::new(&env))
    }

    /// Get TWAP fallback price for an asset. Returns None if not set.
    pub fn get_twap_price(env: Env, asset: Address) -> Option<i128> {
        env.storage()
            .instance()
            .get::<DataKey, i128>(&DataKey::TwapPrice(asset))
    }

    /// Get the admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set")
    }

    // ── Internal helpers ───────────────────────────────────────────────

    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised");
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }

    /// Compute the median of a non-empty price sample vector.
    /// Identical algorithm to `lending::median_price`.
    fn median_price(env: &Env, prices: &Vec<i128>) -> i128 {
        let len = prices.len();
        if len == 0 {
            panic!("No oracle price samples available");
        }

        let mut remaining = Vec::new(env);
        for price in prices.iter() {
            remaining.push_back(price);
        }

        let midpoint = len / 2;
        let even = len.is_multiple_of(2);
        let mut lower = 0i128;

        for step in 0..=midpoint {
            let mut min_idx: u32 = 0;
            let mut min_value = remaining.get(0).expect("No oracle price samples available");

            let mut idx: u32 = 1;
            while idx < remaining.len() {
                let value = remaining
                    .get(idx)
                    .expect("No oracle price samples available");
                if value < min_value {
                    min_value = value;
                    min_idx = idx;
                }
                idx += 1;
            }

            remaining.remove(min_idx);

            if !even && step == midpoint {
                return min_value;
            }

            if even {
                if step == midpoint - 1 {
                    lower = min_value;
                }
                if step == midpoint {
                    return lower
                        .checked_add(min_value)
                        .expect("Overflow computing median price")
                        / 2;
                }
            }
        }

        panic!("Unable to compute median oracle price")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MockOracleContract, ());
        let admin = Address::generate(&env);
        let client = MockOracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, contract_id, admin)
    }

    fn client(env: &Env, contract_id: &soroban_sdk::Address) -> MockOracleContractClient {
        MockOracleContractClient::new(env, contract_id)
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        assert_eq!(c.get_admin(), admin);
    }

    #[test]
    #[should_panic(expected = "Contract already initialised")]
    fn test_double_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MockOracleContract, ());
        let c = MockOracleContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        c.initialize(&admin);
        c.initialize(&admin);
    }

    #[test]
    fn test_set_and_get_price() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        let price = PRICE_PRECISION * 150; // 150.0

        c.set_price(&admin, &asset, &price);
        assert_eq!(c.get_price(&asset), price);
    }

    #[test]
    fn test_set_price_overwrites() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);

        c.set_price(&admin, &asset, &(PRICE_PRECISION * 100));
        assert_eq!(c.get_price(&asset), PRICE_PRECISION * 100);

        c.set_price(&admin, &asset, &(PRICE_PRECISION * 200));
        assert_eq!(c.get_price(&asset), PRICE_PRECISION * 200);
    }

    #[test]
    #[should_panic(expected = "Price must be positive")]
    fn test_set_price_zero_panics() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        c.set_price(&admin, &asset, &0);
    }

    #[test]
    #[should_panic(expected = "Price must be positive")]
    fn test_set_price_negative_panics() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        c.set_price(&admin, &asset, &(-1));
    }

    #[test]
    #[should_panic(expected = "Unauthorised: caller is not admin")]
    fn test_set_price_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MockOracleContract, ());
        let c = MockOracleContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let not_admin = Address::generate(&env);
        let asset = Address::generate(&env);

        c.initialize(&admin);
        c.set_price(&not_admin, &asset, &(PRICE_PRECISION * 10));
    }

    #[test]
    #[should_panic(expected = "No price set for asset")]
    fn test_get_price_unset_panics() {
        let (env, contract_id, _admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        c.get_price(&asset);
    }

    #[test]
    fn test_set_and_get_prices_bulk() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        let prices = soroban_sdk::vec![
            &env,
            PRICE_PRECISION * 100,
            PRICE_PRECISION * 110,
            PRICE_PRECISION * 120,
        ];

        c.set_prices(&admin, &asset, &prices);
        let stored = c.get_prices(&asset);
        assert_eq!(stored.len(), 3);
        assert_eq!(stored.get(0).unwrap(), PRICE_PRECISION * 100);
        assert_eq!(stored.get(1).unwrap(), PRICE_PRECISION * 110);
        assert_eq!(stored.get(2).unwrap(), PRICE_PRECISION * 120);
    }

    #[test]
    fn test_median_odd_count() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        let prices = soroban_sdk::vec![
            &env,
            PRICE_PRECISION * 200,
            PRICE_PRECISION * 100,
            PRICE_PRECISION * 150,
        ];

        c.set_prices(&admin, &asset, &prices);
        // Median of [100, 150, 200] = 150
        assert_eq!(c.get_price(&asset), PRICE_PRECISION * 150);
    }

    #[test]
    fn test_median_even_count() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        let prices = soroban_sdk::vec![
            &env,
            PRICE_PRECISION * 100,
            PRICE_PRECISION * 200,
            PRICE_PRECISION * 150,
            PRICE_PRECISION * 300,
        ];

        c.set_prices(&admin, &asset, &prices);
        // Sorted: [100, 150, 200, 300] -> median = (150 + 200) / 2 = 175
        assert_eq!(c.get_price(&asset), PRICE_PRECISION * 175);
    }

    #[test]
    #[should_panic(expected = "At least one oracle price sample is required")]
    fn test_set_prices_empty_panics() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        let prices = Vec::new(&env);
        c.set_prices(&admin, &asset, &prices);
    }

    #[test]
    fn test_set_and_get_twap_price() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        let twap = PRICE_PRECISION * 42; // 42.0

        assert_eq!(c.get_twap_price(&asset), None);
        c.set_twap_price(&admin, &asset, &twap);
        assert_eq!(c.get_twap_price(&asset), Some(twap));
    }

    #[test]
    #[should_panic(expected = "TWAP price must be positive")]
    fn test_set_twap_price_zero_panics() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        c.set_twap_price(&admin, &asset, &0);
    }

    #[test]
    fn test_multiple_assets_isolated() {
        let (env, contract_id, admin) = setup();
        let c = client(&env, &contract_id);
        let asset_a = Address::generate(&env);
        let asset_b = Address::generate(&env);

        c.set_price(&admin, &asset_a, &(PRICE_PRECISION * 100));
        c.set_price(&admin, &asset_b, &(PRICE_PRECISION * 250));

        assert_eq!(c.get_price(&asset_a), PRICE_PRECISION * 100);
        assert_eq!(c.get_price(&asset_b), PRICE_PRECISION * 250);
    }

    #[test]
    fn test_get_prices_unset_returns_empty() {
        let (env, contract_id, _admin) = setup();
        let c = client(&env, &contract_id);
        let asset = Address::generate(&env);
        assert_eq!(c.get_prices(&asset).len(), 0);
    }
}
