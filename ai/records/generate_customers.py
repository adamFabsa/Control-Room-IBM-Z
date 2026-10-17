"""Creates 1,000,000 synthetic customer accounts in PostgreSQL on the LUKS-encrypted volume.

medical_device is encrypted again per row with pgcrypto (AES-256-CBC, random IV); OpenSSL runs
AES on the CPACF crypto unit. Every record is synthetic. Runs inside the server container:

    podman exec control-room_server_1 python3 /app/ai/records/generate_customers.py
"""
import os
import time

import numpy as np
import psycopg

from app.stub_engine import CIRCUITS  # the 15 circuits from the spec's Game numbers

TOTAL = 1_000_000  # about 2.6 people per account across 2.6 million people
TRACTS_PER_CIRCUIT = 20

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 16-byte random IV, then AES-256-CBC ciphertext. k is the hex PGCRYPTO_KEY.
CREATE OR REPLACE FUNCTION encrypt_flag(v boolean, k text) RETURNS bytea LANGUAGE sql VOLATILE AS $$
    SELECT iv || encrypt_iv(convert_to(v::text, 'UTF8'), decode(k, 'hex'), iv, 'aes-cbc')
    FROM (SELECT gen_random_bytes(16) AS iv) s
$$;
CREATE OR REPLACE FUNCTION decrypt_flag(c bytea, k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT convert_from(decrypt_iv(substring(c FROM 17), decode(k, 'hex'), substring(c FOR 16), 'aes-cbc'), 'UTF8')::boolean
$$;

DROP TABLE IF EXISTS customers;
CREATE TABLE customers (
    account_id     bigint PRIMARY KEY,
    circuit_id     text NOT NULL,
    tract          text NOT NULL,
    vulnerability  real NOT NULL,
    customer_type  text NOT NULL,
    medical_device bytea NOT NULL  -- encrypt_flag(boolean)
);
DROP TABLE IF EXISTS customers_plain;
CREATE UNLOGGED TABLE customers_plain (
    account_id bigint, circuit_id text, tract text, vulnerability real,
    customer_type text, medical_device boolean
);
"""


def synthesize(rng):
    people = np.array([c[2] for c in CIRCUITS], dtype=float)
    counts = np.floor(people / people.sum() * TOTAL).astype(int)
    counts[0] += TOTAL - counts.sum()
    circuit = np.repeat([c[0] for c in CIRCUITS], counts)
    circuit_no = np.repeat(np.arange(1, len(CIRCUITS) + 1), counts)
    tract_no = rng.integers(1, TRACTS_PER_CIRCUIT + 1, TOTAL)
    vulnerability = np.clip(np.repeat([c[4] for c in CIRCUITS], counts) + rng.normal(0, 0.1, TOTAL), 0, 1).round(2)
    kind = rng.choice(["residential", "commercial", "critical"], TOTAL, p=[0.92, 0.075, 0.005])
    medical = (kind == "residential") & (rng.random(TOTAL) < 0.02 + 0.04 * vulnerability)
    # Synthetic tract codes in Dallas County's FIPS prefix (48113), not real tracts.
    tract = [f"48113{c:02d}{t:02d}00" for c, t in zip(circuit_no, tract_no)]
    return zip(range(1, TOTAL + 1), circuit, tract, vulnerability.tolist(), kind, medical.tolist())


def main():
    key = os.environ["PGCRYPTO_KEY"]
    rng = np.random.default_rng(2021)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute(SCHEMA)

        t = time.perf_counter()
        with conn.cursor().copy("COPY customers_plain FROM STDIN") as copy:
            for row in synthesize(rng):
                copy.write_row(row)
        print(f"generated and loaded {TOTAL:,} synthetic rows in {time.perf_counter() - t:.1f}s")

        t = time.perf_counter()
        conn.execute("""
            INSERT INTO customers
            SELECT account_id, circuit_id, tract, vulnerability, customer_type, encrypt_flag(medical_device, %s)
            FROM customers_plain""", (key,))
        dt = time.perf_counter() - t
        print(f"encrypted medical_device for {TOTAL:,} rows in {dt:.1f}s ({TOTAL / dt:,.0f} records/s)")
        conn.execute("DROP TABLE customers_plain")
        conn.execute("CREATE INDEX customers_circuit ON customers (circuit_id)")
        conn.commit()
        conn.execute("ANALYZE customers")

        t = time.perf_counter()
        rows = conn.execute("""
            SELECT circuit_id, count(*), count(*) FILTER (WHERE decrypt_flag(medical_device, %s))
            FROM customers GROUP BY circuit_id ORDER BY circuit_id""", (key,)).fetchall()
        dt = time.perf_counter() - t
        print(f"decrypted and counted {TOTAL:,} records in {dt:.2f}s ({TOTAL / dt:,.0f} records/s)")
        for circuit_id, accounts, medical in rows:
            print(f"  {circuit_id}: {accounts:>7,} accounts, {medical:>6,} with a medical device")


if __name__ == "__main__":
    main()
