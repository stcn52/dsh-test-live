"""A tiny pytest project: it exists so the plugin's python path can be run end
to end from the panel, not only from a checked-in capture."""


def test_adds():
    assert 1 + 1 == 2


def test_joins():
    assert "a" + "b" == "ab"
