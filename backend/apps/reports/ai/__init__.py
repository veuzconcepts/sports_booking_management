"""Read-only AI reporting assistant.

The split is deliberate and is the whole safety argument:

    tools.py    what the assistant may ask for, and the scope it is answered in
    service.py  turning a question into tool calls and a structured answer
    client.py   talking to the model provider
    cache.py    not asking the model the same question twice

`tools.py` is the security boundary. The model never reaches the ORM, never
sees SQL, and cannot name a function that is not in the registry. Every write
path is absent rather than forbidden: there is no tool that mutates anything,
so a prompt asking for one has nothing to call.
"""
