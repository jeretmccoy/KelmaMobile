import { htmlToText } from './theme';

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
