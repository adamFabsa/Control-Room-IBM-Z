"""Counts customers on cut circuits from the encrypted customer table (ai/records), off the game loop.

Every cut and restore recounts that circuit's accounts and medical-device customers, decrypting
medical_device in PostgreSQL. Only totals leave the server.
"""
import asyncio
import logging
import os
import threading
import time

log = logging.getLogger("controlroom.records")

COUNT_SQL = """
    SELECT count(*), count(*) FILTER (WHERE decrypt_flag(medical_device, %s))
    FROM customers WHERE circuit_id = %s
"""


def base_circuit(circuit_id):
    return circuit_id[:4]  # smart-switch halves (e.g. C-04A) share their circuit's customers


class Records:
    def __init__(self):
        self.url = os.environ.get("DATABASE_URL")
        self.key = os.environ.get("PGCRYPTO_KEY")
        self.enabled = bool(self.url and self.key)
        self.counts = {}  # circuit id -> (accounts, medical)
        self.medical = {}  # circuit id -> medical-device customers, counted once at startup for the screens
        self.pending = set()
        self.records_counted = 0
        self.seconds = 0.0
        self._conn = None
        self._lock = threading.Lock()

    def _count(self, circuit_id):
        with self._lock:
            if self._conn is None or self._conn.closed:
                import psycopg
                self._conn = psycopg.connect(self.url, autocommit=True)
            start = time.perf_counter()
            accounts, medical = self._conn.execute(COUNT_SQL, (self.key, circuit_id)).fetchone()
            elapsed = time.perf_counter() - start
        self.records_counted += accounts
        self.seconds += elapsed
        log.info("counted %d records on %s in %.3fs (%.0f records/s)",
                 accounts, circuit_id, elapsed, accounts / elapsed if elapsed else 0)
        return accounts, medical

    async def recount(self, circuit_id):
        """Returns True when a new count landed."""
        circuit_id = base_circuit(circuit_id)
        if not self.enabled or circuit_id in self.pending:
            return False
        self.pending.add(circuit_id)
        try:
            self.counts[circuit_id] = await asyncio.to_thread(self._count, circuit_id)
            return True
        except Exception:
            log.exception("customer count failed; turning customer totals off")
            self.enabled = False
            return False
        finally:
            self.pending.discard(circuit_id)

    async def preload(self):
        """Every circuit's medical-device customers, decrypted once (about 3 s) for the neighborhood cards."""
        if not self.enabled:
            return
        def query():
            with self._lock:
                if self._conn is None or self._conn.closed:
                    import psycopg
                    self._conn = psycopg.connect(self.url, autocommit=True)
                return self._conn.execute(
                    "SELECT circuit_id, count(*) FILTER (WHERE decrypt_flag(medical_device, %s)) FROM customers GROUP BY 1",
                    (self.key,)).fetchall()
        try:
            self.medical = {cid: n for cid, n in await asyncio.to_thread(query)}
        except Exception:
            log.exception("medical-device preload failed")

    def missing(self, circuits):
        """Cut circuits that have no count yet."""
        if not self.enabled:
            return []
        dark = {base_circuit(c["id"]) for c in circuits if not c["on"]}
        return [cid for cid in dark if cid not in self.counts and cid not in self.pending]

    def add_totals(self, state):
        if not self.enabled:
            return
        dark = {base_circuit(c["id"]) for c in state["circuits"] if not c["on"]}
        counted = [self.counts[cid] for cid in dark if cid in self.counts]
        state["totals"]["accounts_no_power"] = sum(a for a, _ in counted)
        state["totals"]["medical_no_power"] = sum(m for _, m in counted)

    def stats(self):
        return {"enabled": self.enabled, "records_counted": self.records_counted,
                "seconds": round(self.seconds, 3),
                "records_per_sec": round(self.records_counted / self.seconds) if self.seconds else None}
