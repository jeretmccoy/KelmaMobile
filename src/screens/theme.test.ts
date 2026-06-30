import { extractSoundTags, htmlToText } from './theme';

describe('htmlToText', () => {
  it('renders Anki card HTML as readable text', () => {
    expect(htmlToText('Hello&nbsp;<b>world</b>')).toBe('Hello world');
  });

  it('turns block and break tags into line breaks', () => {
    expect(htmlToText('a<br>b<div>c</div>')).toBe('a\nb\nc');
  });

  it('decodes common entities and trims whitespace', () => {
    expect(htmlToText('  &lt;tag&gt; &amp; &quot;q&quot;  ')).toBe('<tag> & "q"');
  });
});

describe('sound tags', () => {
  it('extracts audio resources and hides the filename from the text', () => {
    const html = 'What is this? [sound:audio1.mp3] [sound:audio2.mp3]';
    expect(extractSoundTags(html)).toEqual(['audio1.mp3', 'audio2.mp3']);
    expect(htmlToText(html)).toBe('What is this?');
  });

  it('leaves text without audio untouched', () => {
    expect(extractSoundTags('no audio here')).toEqual([]);
    expect(htmlToText('no audio here')).toBe('no audio here');
  });
});
