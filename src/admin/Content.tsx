import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PhotoPicker } from '../components/PhotoPicker';
import { Confirm, Empty, Field, Icon, Modal, Notice, Pager, Spinner, Toggle, useToast } from '../components/ui';
import { removePhoto } from '../lib/image';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtDateMed } from '../lib/time';
import type { Announcement, CarouselPhoto } from '../lib/types';

// ====================================================================== announcements
export function Announcements() {
  const toast = useToast();
  const [rows, setRows] = useState<Announcement[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const [removing, setRemoving] = useState<Announcement | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err, count } = await supabase.from('announcements').select('*', { count: 'exact' })
      .order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    if (err) setError(toAppError(err).message);
    else {
      setRows((data as Announcement[]) ?? []);
      setTotal(count ?? 0);
      setError(null);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const setPublished = async (a: Announcement, is_published: boolean) => {
    const { error: err } = await supabase.from('announcements').update({ is_published }).eq('id', a.id);
    if (err) toast(toAppError(err).message, 'error');
    else toast(is_published ? 'Announcement published.' : 'Announcement unpublished.');
    void load();
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error: err } = await supabase.from('announcements').delete().eq('id', removing.id);
    setBusy(false);
    if (err) toast(toAppError(err).message, 'error');
    else {
      void removePhoto(removing.image_path);
      toast('Announcement removed.');
    }
    setRemoving(null);
    void load();
  };

  return (
    <div className="stack">
      <div className="title-row">
        <h1 className="page-title">Announcements</h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New</button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && rows.length === 0 && <Empty icon="megaphone" title="No announcements yet">Create one to show it on the home page.</Empty>}
      {rows !== null && rows.length > 0 && (
        <ul className="rows card">
          {rows.map((a) => (
            <li key={a.id} className="row">
              {a.image_path && <img className="thumb" src={photoUrl(a.image_path)} alt="" loading="lazy" decoding="async" />}
              <span className="row-main">
                <strong>{a.title}</strong>
                <span className="small muted clamp-1">{a.body}</span>
                <span className="tiny muted">
                  <span className={`badge ${a.is_published ? 'badge-ok' : 'badge-off'}`}>{a.is_published ? 'Published' : 'Draft'}</span>{' '}
                  {a.is_published && a.published_at ? fmtDateMed(a.published_at) : `Edited ${fmtDateMed(a.updated_at)}`}
                </span>
              </span>
              <span className="row-actions">
                <button type="button" className="btn btn-sm" onClick={() => void setPublished(a, !a.is_published)}>{a.is_published ? 'Unpublish' : 'Publish'}</button>
                <button type="button" className="icon-btn" onClick={() => setEditing(a)} aria-label={`Edit ${a.title}`}><Icon name="edit" size={18} /></button>
                <button type="button" className="icon-btn" onClick={() => setRemoving(a)} aria-label={`Delete ${a.title}`}><Icon name="trash" size={18} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />

      {editing && <AnnouncementDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {removing && (
        <Confirm title="Delete this announcement?" danger busy={busy} confirmLabel="Delete" onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>“{removing.title}” and its photo will be removed permanently.</p>
        </Confirm>
      )}
    </div>
  );
}

function AnnouncementDialog({ item, onClose, onSaved }: { item: Announcement | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [imagePath, setImagePath] = useState<string | null>(item?.image_path ?? null);
  const [imageAlt, setImageAlt] = useState(item?.image_alt ?? '');
  const [published, setPublished] = useState(item?.is_published ?? false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Photos uploaded in this dialog but not kept are deleted again.
  const discardUnsaved = () => {
    if (imagePath && imagePath !== item?.image_path) void removePhoto(imagePath);
  };
  const close = () => {
    discardUnsaved();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('Enter a title.');
    setBusy(true);
    setError(null);
    const payload = { title: title.trim(), body: body.trim(), image_path: imagePath, image_alt: imageAlt.trim(), is_published: published };
    const res = item
      ? await supabase.from('announcements').update(payload).eq('id', item.id)
      : await supabase.from('announcements').insert(payload);
    setBusy(false);
    if (res.error) return setError(toAppError(res.error).message);
    if (item?.image_path && item.image_path !== imagePath) void removePhoto(item.image_path);
    toast(published ? 'Saved and published.' : 'Saved as draft.');
    onSaved();
  };

  if (picking) {
    return (
      <PhotoPicker folder="announcements" title="Announcement photo" onClose={() => setPicking(false)}
        onUploaded={(path) => {
          discardUnsaved();
          setImagePath(path);
        }} />
    );
  }

  return (
    <Modal title={item ? 'Edit announcement' : 'New announcement'} onClose={close} wide>
      <form className="form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required /></Field>
        <Field label="Details" hint={`${body.length} / 5000`}>
          <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
        </Field>
        <div className="field">
          <span className="field-label">Photo (optional)</span>
          {imagePath && <img src={photoUrl(imagePath)} alt={imageAlt} className="photo-preview" />}
          <div className="btn-row">
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setPicking(true)}><Icon name="image" size={16} /> {imagePath ? 'Replace photo' : 'Add photo'}</button>
            {imagePath && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { discardUnsaved(); setImagePath(null); }}>Remove photo</button>}
          </div>
        </div>
        {imagePath && (
          <Field label="Photo description (alternative text)" hint="Describes the photo for people using screen readers.">
            <input type="text" value={imageAlt} onChange={(e) => setImageAlt(e.target.value)} maxLength={200} />
          </Field>
        )}
        <Toggle checked={published} onChange={setPublished} label={published ? 'Published — visible on the home page' : 'Draft — not visible to the public'} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Save announcement'}</button>
      </form>
    </Modal>
  );
}

// ====================================================================== carousel photos
export function Photos() {
  const toast = useToast();
  const [rows, setRows] = useState<CarouselPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<CarouselPhoto | null>(null);
  const [editing, setEditing] = useState<CarouselPhoto | null>(null);
  const [removing, setRemoving] = useState<CarouselPhoto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from('carousel_photos').select('*').order('sort_order').order('created_at');
    if (err) setError(toAppError(err).message);
    else {
      setRows((data as CarouselPhoto[]) ?? []);
      setError(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const list = rows ?? [];
  const shown = list.slice((page - 1) * pageSize, page * pageSize);

  const add = async (path: string) => {
    const next = list.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1;
    const { data, error: err } = await supabase.from('carousel_photos').insert({ image_path: path, sort_order: next }).select('*').single();
    if (err) {
      void removePhoto(path);
      throw new Error(toAppError(err).message);
    }
    toast('Photo added to the carousel. Add a caption and description.');
    await load();
    setEditing(data as CarouselPhoto);
  };

  const replace = async (path: string) => {
    if (!replacing) return;
    const { error: err } = await supabase.from('carousel_photos').update({ image_path: path }).eq('id', replacing.id);
    if (err) {
      void removePhoto(path);
      throw new Error(toAppError(err).message);
    }
    void removePhoto(replacing.image_path);
    toast('Photo replaced.');
    await load();
  };

  const move = async (photo: CarouselPhoto, delta: -1 | 1) => {
    const i = list.findIndex((p) => p.id === photo.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const reordered = [...list];
    [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
    setRows(reordered.map((p, k) => ({ ...p, sort_order: k + 1 })));
    const changes = reordered.map((p, k) => ({ id: p.id, sort_order: k + 1, was: p.sort_order })).filter((c) => c.sort_order !== c.was);
    const results = await Promise.all(changes.map((c) => supabase.from('carousel_photos').update({ sort_order: c.sort_order }).eq('id', c.id)));
    const failed = results.find((r) => r.error);
    if (failed?.error) toast(toAppError(failed.error).message, 'error');
    void load();
  };

  const setActive = async (photo: CarouselPhoto, is_active: boolean) => {
    const { error: err } = await supabase.from('carousel_photos').update({ is_active }).eq('id', photo.id);
    if (err) toast(toAppError(err).message, 'error');
    void load();
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error: err } = await supabase.from('carousel_photos').delete().eq('id', removing.id);
    setBusy(false);
    if (err) toast(toAppError(err).message, 'error');
    else {
      void removePhoto(removing.image_path);
      toast('Photo removed.');
    }
    setRemoving(null);
    void load();
  };

  return (
    <div className="stack">
      <div className="title-row">
        <h1 className="page-title">Carousel photos</h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add photo</button>
      </div>
      <p className="muted small">Every photo is converted to WebP and compressed to 300 KB or less automatically before it is stored.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && list.length === 0 && <Empty icon="image" title="No photos yet">Add photos of the courts to feature them on the home page.</Empty>}

      {shown.length > 0 && (
        <ul className="rows card">
          {shown.map((p) => {
            const i = list.findIndex((x) => x.id === p.id);
            return (
              <li key={p.id} className="row row-photo">
                <img className="thumb thumb-lg" src={photoUrl(p.image_path)} alt={p.alt_text} loading="lazy" decoding="async" />
                <span className="row-main">
                  <strong>{p.caption || <span className="muted">No caption</span>}</strong>
                  <span className="small muted clamp-1">{p.alt_text ? `Alt: ${p.alt_text}` : 'No description (alternative text) yet'}</span>
                  <Toggle checked={p.is_active} onChange={(v) => void setActive(p, v)} label={p.is_active ? 'Shown' : 'Hidden'} />
                </span>
                <span className="row-actions">
                  <button type="button" className="icon-btn" onClick={() => void move(p, -1)} disabled={i === 0} aria-label="Move earlier"><Icon name="up" size={18} /></button>
                  <button type="button" className="icon-btn" onClick={() => void move(p, 1)} disabled={i === list.length - 1} aria-label="Move later"><Icon name="down" size={18} /></button>
                  <button type="button" className="icon-btn" onClick={() => setEditing(p)} aria-label="Edit caption and description"><Icon name="edit" size={18} /></button>
                  <button type="button" className="icon-btn" onClick={() => setReplacing(p)} aria-label="Replace or re-crop photo"><Icon name="refresh" size={18} /></button>
                  <button type="button" className="icon-btn" onClick={() => setRemoving(p)} aria-label="Remove photo"><Icon name="trash" size={18} /></button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Pager page={page} pageSize={pageSize} total={list.length} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />

      {adding && <PhotoPicker folder="carousel" title="Add carousel photo" onClose={() => setAdding(false)} onUploaded={add} />}
      {replacing && <PhotoPicker folder="carousel" title="Replace photo" onClose={() => setReplacing(null)} onUploaded={replace} />}
      {editing && <CaptionDialog photo={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {removing && (
        <Confirm title="Remove this photo?" danger busy={busy} confirmLabel="Remove" onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <img src={photoUrl(removing.image_path)} alt={removing.alt_text} className="photo-preview" />
          <p className="muted small">It will be taken off the home page and deleted from storage.</p>
        </Confirm>
      )}
    </div>
  );
}

function CaptionDialog({ photo, onClose, onSaved }: { photo: CarouselPhoto; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [caption, setCaption] = useState(photo.caption);
  const [alt, setAlt] = useState(photo.alt_text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error: err } = await supabase.from('carousel_photos').update({ caption: caption.trim(), alt_text: alt.trim() }).eq('id', photo.id);
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast('Photo details saved.');
    onSaved();
  };

  return (
    <Modal title="Caption and description" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <img src={photoUrl(photo.image_path)} alt={alt} className="photo-preview" />
        <Field label="Caption" hint="Shown over the photo on the home page.">
          <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={140} />
        </Field>
        <Field label="Description (alternative text)" hint="Describes the photo for people using screen readers.">
          <input type="text" value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={200} />
        </Field>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </Modal>
  );
}
