"""``RunConfig`` wire shape."""

from __future__ import annotations

from xray import RunConfig


def test_to_wire_emits_only_the_fields_that_were_set():
    assert RunConfig(model="gpt-4o").to_wire() == {"model": "gpt-4o"}


def test_to_wire_carries_model_and_temperature():
    assert RunConfig(model="gpt-4o", temperature=0.5).to_wire() == {
        "model": "gpt-4o",
        "temperature": 0.5,
    }


def test_to_wire_flattens_extra_into_the_top_level():
    wire = RunConfig(model="gpt-4o", extra={"top_p": 0.9, "strategy": "v2"}).to_wire()
    assert wire == {"model": "gpt-4o", "top_p": 0.9, "strategy": "v2"}


def test_to_wire_excludes_name_so_relabelling_cannot_fork_the_group():
    """The server hashes this object to derive the group's identity, so the
    label must not be part of it — otherwise renaming a config would create
    a second group instead of relabelling the existing one."""
    assert RunConfig(name="baseline", model="gpt-4o").to_wire() == {"model": "gpt-4o"}


def test_two_configs_differing_only_by_name_have_identical_wire_content():
    assert (
        RunConfig(name="baseline", model="gpt-4o").to_wire()
        == RunConfig(name="control-group", model="gpt-4o").to_wire()
    )


def test_name_is_readable_off_the_dataclass_for_the_orchestrator_to_send():
    assert RunConfig(name="baseline").name == "baseline"
    assert RunConfig().name is None
