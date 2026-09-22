"""The settings a production deployment actually runs under.

Two bugs reached the live server through this gap, and neither was visible to
any other test, because every test runs with the development `.env`:

* `DEBUG=True` in production, which silently disabled HSTS, the SSL redirect,
  secure session and CSRF cookies, and the insecure-key boot guard. It was
  found by reading `check --deploy` output, where the one line that mattered
  sat among sixty `drf_spectacular` warnings.
* `SECURE_SSL_REDIRECT` then redirecting the website's own server-side calls
  to `http://127.0.0.1:8000`, which carry no `X-Forwarded-Proto`, so every
  page paid for a 301 and a TLS attempt against a plain HTTP port.

So this boots Django the way the server does, in a subprocess with a
production-shaped environment, and asserts that `check --deploy` comes back
clean. It is slow, and it is the only test here that would have caught either.
"""

import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]


def deploy_check(**overrides):
    """Run `manage.py check --deploy` under a production-shaped environment."""
    env = {
        **os.environ,
        "DJANGO_DEBUG": "False",
        # Long AND varied. Django's own W009 wants 50+ characters and at
        # least 5 distinct ones, so `"x" * 70` passes the boot guard and then
        # trips the check this test is reading.
        "DJANGO_SECRET_KEY": "Km4-tR9xQ2wLp7Vz" * 5,
        "JWT_SIGNING_KEY": "Bn8_yF3jH6sDq1Wc" * 5,
        "DJANGO_ALLOWED_HOSTS": "admin.example.com,www.example.com",
        "PUBLIC_WEBSITE_URL": "https://www.example.com",
        "PUBLIC_BACKEND_URL": "https://admin.example.com",
        "BEHIND_TLS_PROXY": "True",
        "NUM_PROXIES": "1",
    }
    env.update(overrides)
    return subprocess.run(
        [sys.executable, "manage.py", "check", "--deploy"],
        cwd=BACKEND, env=env, capture_output=True, text=True, timeout=180,
    )


def security_lines(output):
    """Only Django's own security warnings. The rest is schema-generation
    noise from drf_spectacular, and burying a real warning in it is how the
    first of these bugs survived."""
    return [ln.strip() for ln in output.splitlines() if "security.W" in ln]


class TestAProductionShapedBoot:
    def test_the_deploy_check_is_clean(self):
        result = deploy_check()
        assert result.returncode == 0, result.stdout + result.stderr
        assert security_lines(result.stdout + result.stderr) == []

    def test_debug_is_refused(self):
        """The one that reached production. With DEBUG on, Django itself
        complains, and every hardening branch in settings is skipped."""
        result = deploy_check(DJANGO_DEBUG="True")
        warnings = security_lines(result.stdout + result.stderr)
        assert any("W018" in w for w in warnings), warnings

    def test_an_insecure_secret_will_not_boot(self):
        result = deploy_check(DJANGO_SECRET_KEY="test")
        assert result.returncode != 0
        assert "DJANGO_SECRET_KEY" in result.stdout + result.stderr

    def test_a_wildcard_host_will_not_boot(self):
        result = deploy_check(DJANGO_ALLOWED_HOSTS="*")
        assert result.returncode != 0
        assert "ALLOWED_HOSTS" in result.stdout + result.stderr

    def test_an_unconfigured_site_address_is_reported(self):
        """`payments.E001`. Split payment links are built from this, and an
        unset value issues links that resolve for nobody."""
        result = deploy_check(PUBLIC_WEBSITE_URL="http://localhost:4321")
        assert result.returncode != 0
        assert "payments.E001" in result.stdout + result.stderr

    def test_behind_a_proxy_django_does_not_redirect_as_well(self):
        """The second bug. nginx owns the http to https redirect, and Django
        doing it too broke every server-side call the website makes to
        loopback, where there is no X-Forwarded-Proto to read."""
        result = deploy_check()
        assert result.returncode == 0, result.stdout + result.stderr
        # W008 is Django's warning that the redirect is off, and it is
        # silenced deliberately. So the count is the assertion: a silenced
        # check is only counted when it actually FIRES, and it only fires when
        # `SECURE_SSL_REDIRECT` is False. Turn the redirect back on and this
        # reads "0 silenced", which is how this test catches the regression.
        assert security_lines(result.stdout + result.stderr) == []
        assert "1 silenced" in result.stdout + result.stderr

    def test_without_a_proxy_django_still_redirects(self):
        """Nobody else would. Turning the redirect off must be a consequence
        of naming a proxy, never the default."""
        result = deploy_check(BEHIND_TLS_PROXY="False")
        warnings = security_lines(result.stdout + result.stderr)
        assert not any("W008" in w for w in warnings), warnings
