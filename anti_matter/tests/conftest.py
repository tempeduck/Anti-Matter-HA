"""Isolated API fixtures. No Supervisor token or production vault is used."""
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERVISOR_TOKEN", raising=False)
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("ANTIMATTER_MEDIA", str(tmp_path / "media"))
    monkeypatch.setenv("ANTIMATTER_OPTIONS", str(tmp_path / "options.json"))
    import main
    return importlib.reload(main)


@pytest.fixture
def client(app_module):
    from fastapi.testclient import TestClient
    return TestClient(app_module.app)
