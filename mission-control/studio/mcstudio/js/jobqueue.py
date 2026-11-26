"""Jarvis Studio's background-queue decorator. The studio worker runs jobs, so this only keeps the
decorated function as it is."""


def handler(name: str, label: str = ""):
    def wrap(fn):
        return fn

    return wrap
