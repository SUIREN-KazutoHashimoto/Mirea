from pathlib import Path
import stat
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"scripts"))
from radio_voicevox_capi import select_adapter, protected_posix_asset

class FakePath:
    def __init__(self, name, mode, uid, parents=(), absolute=True):
        self.name=name; self.info=types.SimpleNamespace(st_mode=mode,st_uid=uid)
        self.parents=parents; self.absolute=absolute
    def is_absolute(self): return self.absolute
    def resolve(self, *, strict): assert strict; return self
    def stat(self): return self.info

class VoicePlatform(unittest.TestCase):
    def test_platform(self):
        self.assertEqual(select_adapter("nt","Windows","AMD64",8),"windows-x64")
        self.assertEqual(select_adapter("posix","Linux","x86_64",8),"linux-x64")
        for args in [("posix","Darwin","x86_64",8),("posix","Linux","arm64",8),
                     ("posix","Linux","x86_64",4),("nt","Linux","x86_64",8)]:
            with self.assertRaises(RuntimeError): select_adapter(*args)

    def test_posix_ownership_and_path_rules(self):
        root=FakePath("app",stat.S_IFDIR|0o755,0)
        name="libvoicevox_core.so"
        p=FakePath(name,stat.S_IFREG|0o644,0,(root,))
        self.assertIs(protected_posix_asset(p,{name}),p)
        self.assertIs(protected_posix_asset(root,directory=True),root)
        with self.assertRaises(ValueError): protected_posix_asset(root)
        for invalid in [FakePath(name,stat.S_IFREG|0o644,1000,(root,)),
                        FakePath(name,stat.S_IFREG|0o664,0,(root,)),
                        FakePath(name,stat.S_IFDIR|0o755,0,(root,)),
                        FakePath(name,stat.S_IFREG|0o644,0,(FakePath("tmp",stat.S_IFDIR|0o777,0),)),
                        FakePath(name,stat.S_IFREG|0o644,0,(FakePath("bind",stat.S_IFDIR|0o755,1000),)),
                        FakePath(name,stat.S_IFREG|0o644,0,(root,),False),
                        FakePath("unexpected.so",stat.S_IFREG|0o644,0,(root,))]:
            with self.assertRaises(ValueError): protected_posix_asset(invalid,{name})

if __name__=="__main__": unittest.main()
