"""Bounded connection pool semantics (ADR-0013).

Hermetic: the factory returns fakes; nothing touches a database. What is
pinned: idle reuse (factory called once for sequential checkouts), growth to
capacity, transient overflow closed on return, and broken connections dropped
without poisoning the pool.
"""

from __future__ import annotations

import psycopg
import pytest

from mro_ai.retrieval import _ConnectionPool


class FakeConn:
    def __init__(self, broken: bool = False) -> None:
        self.closed = False
        self.broken = broken

    def close(self) -> None:
        self.closed = True

    def execute(self, *_args: object, **_kwargs: object) -> object:  # pragma: no cover
        raise AssertionError("pool tests never execute SQL")


def test_reuses_idle_connection_without_refactory() -> None:
    created: list[FakeConn] = []

    def factory(_url: str) -> FakeConn:
        conn = FakeConn()
        created.append(conn)
        return conn

    pool = _ConnectionPool(factory, "postgresql://unused", capacity=4)  # type: ignore[arg-type]
    with pool.checkout() as a:
        pass
    with pool.checkout() as b:
        pass
    assert a is b
    assert len(created) == 1
    assert pool.idle_count() == 1


def test_grows_to_capacity_then_transients_are_closed_on_return() -> None:
    created: list[FakeConn] = []

    def factory(_url: str) -> FakeConn:
        conn = FakeConn()
        created.append(conn)
        return conn

    pool = _ConnectionPool(factory, "postgresql://unused", capacity=2)  # type: ignore[arg-type]

    held: list[object] = []
    for _ in range(2):
        cm = pool.checkout()
        held.append(cm)
        cm.__enter__()  # hold both pooled slots open
    # Third concurrent checkout must be transient: created, closed on return.
    with pool.checkout() as transient:
        assert len(created) == 3
        assert not transient.closed
    assert created[2].closed

    # Release the pooled slots; they return to idle (not closed).
    held[0].__exit__(None, None, None)  # type: ignore[attr-defined]
    held[1].__exit__(None, None, None)  # type: ignore[attr-defined]
    assert not created[0].closed and not created[1].closed
    assert pool.idle_count() == 2


def test_broken_connection_is_dropped_and_pool_recovers() -> None:
    created: list[FakeConn] = []

    def factory(_url: str) -> FakeConn:
        conn = FakeConn()
        created.append(conn)
        return conn

    pool = _ConnectionPool(factory, "postgresql://unused", capacity=4)  # type: ignore[arg-type]
    with pytest.raises(psycopg.OperationalError), pool.checkout() as conn:
        conn.broken = True
        raise psycopg.OperationalError("db restarted")

    assert created[0].closed
    with pool.checkout() as conn:
        assert conn is created[1]  # fresh connection, pool not poisoned
    assert pool.idle_count() == 1


def test_factory_failure_on_growing_checkout_does_not_corrupt_accounting() -> None:
    attempts = {"n": 0}

    def factory(_url: str) -> FakeConn:
        attempts["n"] += 1
        raise RuntimeError("pg is down")

    pool = _ConnectionPool(factory, "postgresql://unused", capacity=4)  # type: ignore[arg-type]
    for _ in range(2):
        with pytest.raises(RuntimeError), pool.checkout():
            pass  # pragma: no cover
    assert attempts["n"] == 2  # each checkout retried the factory independently
