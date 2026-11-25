import unittest
from bindings import verify


class ListenerTest(unittest.TestCase):
    def test_only_one_loopback_socket_owned_by_expected_pid(self):
        row = 'LISTEN 0 128 127.0.0.1:55436 0.0.0.0:* users:(("postgres",pid=123,fd=5))'
        verify(row, 55436, 123)
        for invalid in [row.replace("127.0.0.1", "*"), row.replace("123,", "1234,"),
                        row + "\n" + row, row.split("users:")[0], ""]:
            with self.assertRaises(ValueError):
                verify(invalid, 55436, 123)
