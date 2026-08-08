#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

fn setup_test() -> (Env, Address, ZkCreditVerifierContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ZkCreditVerifierContract, ());
    let client = ZkCreditVerifierContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    (env, admin, client)
}

#[test]
fn test_initialize_and_register_provider() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let pubkey_hash = BytesN::from_array(&env, &[7u8; 32]);

    assert!(!client.is_provider_registered(&provider_id));

    client.register_provider(&admin, &provider_id, &pubkey_hash);
    assert!(client.is_provider_registered(&provider_id));
    assert_eq!(client.get_total_verifications(), 0);
}

#[test]
fn test_verify_credit_proof_success() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let pubkey_hash = BytesN::from_array(&env, &[1u8; 32]);
    client.register_provider(&admin, &provider_id, &pubkey_hash);

    let borrower = Address::generate(&env);
    let nullifier = BytesN::from_array(&env, &[9u8; 32]);
    let mut proof_array = [0u8; 64];
    proof_array[0] = 0xab;
    proof_array[63] = 0xcd;
    let proof_bytes = BytesN::from_array(&env, &proof_array);

    let expiration = env.ledger().timestamp() + 3600;

    let payload = ZkProofPayload {
        nullifier: nullifier.clone(),
        proof_bytes,
        min_score_threshold: 750,
        target_tier: 3, // Gold
        provider_id: provider_id.clone(),
        expiration,
    };

    assert!(!client.is_nullifier_used(&nullifier));

    let record = client.verify_credit_proof(&borrower, &payload);

    assert_eq!(record.borrower, borrower);
    assert_eq!(record.min_score_threshold, 750);
    assert_eq!(record.tier_granted, 3);
    assert_eq!(record.nullifier, nullifier);
    assert!(client.is_nullifier_used(&nullifier));
    assert_eq!(client.get_total_verifications(), 1);

    let stored = client.get_borrower_record(&borrower);
    assert_eq!(stored.tier_granted, 3);
}

#[test]
#[should_panic(expected = "Nullifier already spent")]
fn test_nullifier_reuse_panics() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "PolygonID-Experian");
    let pubkey_hash = BytesN::from_array(&env, &[2u8; 32]);
    client.register_provider(&admin, &provider_id, &pubkey_hash);

    let borrower = Address::generate(&env);
    let nullifier = BytesN::from_array(&env, &[5u8; 32]);
    let mut proof_array = [0u8; 64];
    proof_array[10] = 0xff;
    let proof_bytes = BytesN::from_array(&env, &proof_array);
    let expiration = env.ledger().timestamp() + 3600;

    let payload = ZkProofPayload {
        nullifier: nullifier.clone(),
        proof_bytes: proof_bytes.clone(),
        min_score_threshold: 800,
        target_tier: 4,
        provider_id: provider_id.clone(),
        expiration,
    };

    client.verify_credit_proof(&borrower, &payload);

    // Second call with same nullifier should panic
    client.verify_credit_proof(&borrower, &payload);
}

#[test]
#[should_panic(expected = "ZK Proof has expired")]
fn test_expired_proof_panics() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let pubkey_hash = BytesN::from_array(&env, &[3u8; 32]);
    client.register_provider(&admin, &provider_id, &pubkey_hash);

    let borrower = Address::generate(&env);
    let nullifier = BytesN::from_array(&env, &[4u8; 32]);
    let mut proof_array = [0u8; 64];
    proof_array[0] = 0x01;
    let proof_bytes = BytesN::from_array(&env, &proof_array);
    env.ledger().set_timestamp(1_000_000_000);
    let expiration = env.ledger().timestamp() - 10; // Expired

    let payload = ZkProofPayload {
        nullifier,
        proof_bytes,
        min_score_threshold: 700,
        target_tier: 2,
        provider_id,
        expiration,
    };

    client.verify_credit_proof(&borrower, &payload);
}

#[test]
#[should_panic(expected = "Unregistered ZK proof provider")]
fn test_unregistered_provider_panics() {
    let (env, _admin, client) = setup_test();

    let borrower = Address::generate(&env);
    let nullifier = BytesN::from_array(&env, &[12u8; 32]);
    let mut proof_array = [0u8; 64];
    proof_array[0] = 0x01;
    let proof_bytes = BytesN::from_array(&env, &proof_array);
    let expiration = env.ledger().timestamp() + 3600;

    let payload = ZkProofPayload {
        nullifier,
        proof_bytes,
        min_score_threshold: 700,
        target_tier: 2,
        provider_id: String::from_str(&env, "UnknownProvider"),
        expiration,
    };

    client.verify_credit_proof(&borrower, &payload);
}

#[test]
#[should_panic(expected = "Invalid ZK proof payload signature")]
fn test_invalid_zero_proof_bytes_panics() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let pubkey_hash = BytesN::from_array(&env, &[4u8; 32]);
    client.register_provider(&admin, &provider_id, &pubkey_hash);

    let borrower = Address::generate(&env);
    let nullifier = BytesN::from_array(&env, &[14u8; 32]);
    let proof_bytes = BytesN::from_array(&env, &[0u8; 64]); // All zero bytes
    let expiration = env.ledger().timestamp() + 3600;

    let payload = ZkProofPayload {
        nullifier,
        proof_bytes,
        min_score_threshold: 700,
        target_tier: 2,
        provider_id,
        expiration,
    };

    client.verify_credit_proof(&borrower, &payload);
}
