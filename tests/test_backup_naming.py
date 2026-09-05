"""Output naming and preflight regressions; all media stays in temporary folders."""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'python'))
from vingest import ingest
from vingest.probe import MediaInfo


def test_missing_selected_master_stops_plan(tmp_path):
    with pytest.raises(ValueError, match='Selected master is unavailable'):
        ingest.build_plan({'targets': [{'masters': [str(tmp_path / 'missing.mov')]}]})


@pytest.mark.parametrize('informal', [False, True])
def test_edit_clip_filename_preserves_extension_and_changes_plan(tmp_path, monkeypatch, informal):
    clip = tmp_path / 'source.MP4'
    clip.write_bytes(b'fixture')
    monkeypatch.setattr(ingest, 'probe', lambda p: MediaInfo(
        path=str(p), name=Path(p).name, size=7, duration=60, mtime=1))
    target = {'source_root': str(tmp_path), 'dest_root': str(tmp_path / 'out'),
              'session_name': 'Parent Event', 'role': 'informal' if informal else 'h265',
              'masters': [] if informal else [str(clip)],
              'cams': {'1': [str(clip)]} if informal else {},
              'rename_camera_clips': informal,
              'clip_names': {str(clip): 'Short Event.MP4'}}
    plan = ingest.build_plan({'targets': [target]})
    assert Path(plan['targets'][0]['items'][0]['dst']).name == 'Short Event.MP4'
    target['clip_names'][str(clip)] = '../escape.MP4'
    with pytest.raises(ValueError, match='Invalid output filename'):
        ingest.build_plan({'targets': [target]})
    target['clip_names'][str(clip)] = 'Wrong.mov'
    with pytest.raises(ValueError, match='original file extension'):
        ingest.build_plan({'targets': [target]})


def test_selected_master_in_existing_folder_is_renamed(tmp_path, monkeypatch):
    folder = tmp_path / 'Correct Parent'
    folder.mkdir()
    clip = folder / 'Old Informal Clip-004.MP4'
    clip.write_bytes(b'fixture')
    monkeypatch.setattr(ingest, 'probe', lambda p: MediaInfo(
        path=str(p), name=Path(p).name, size=7, duration=60, mtime=1))
    plan = ingest.build_plan({'targets': [{
        'source_root': str(tmp_path), 'session_source': str(folder),
        'masters': [str(clip)], 'cams': {}}]})
    item = plan['targets'][0]['items'][0]
    assert Path(item['final_dst']).name == 'Correct Parent Dur-1m0s.MP4'


def test_unsupported_name_fails_before_any_directory_is_created(tmp_path):
    output = tmp_path / 'must-not-exist'
    plan = {'targets': [{'session_path': str(output), 'items': [
        {'dst': str(output / ('x' * 256 + '.mov'))}]}]}
    with pytest.raises(ValueError, match='too long'):
        ingest.execute_plan(plan)
    assert not output.exists()


def test_windows_full_path_limit_includes_parent_folders(tmp_path):
    long_path = tmp_path / ('a' * 100) / ('b' * 100) / ('c' * 100)
    with pytest.raises(ValueError, match='Windows compatibility'):
        ingest.validate_destination_paths({'windows_compatible': True,
            'targets': [{'session_path': str(long_path), 'items': []}]})
