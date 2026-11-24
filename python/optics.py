"""Scalar incoherent defocus surrogate for a thin, intensity-only specimen.
Use a measured PSF for quantitative microscopy. A focused photograph lacks phase
and depth, so this module cannot recover arbitrary 3D specimen defocus exactly.
"""
import numpy as np
from PIL import Image,ImageDraw,ImageFilter

def psf(shape,defocus_m,na=.25,wavelength_m=550e-9,pixel_m=.35e-6):
    h,w=shape;fy=np.fft.fftfreq(h,d=pixel_m);fx=np.fft.fftfreq(w,d=pixel_m);xx,yy=np.meshgrid(fx,fy);rho2=xx*xx+yy*yy
    pupil=(rho2<=(na/wavelength_m)**2)*np.exp(-1j*np.pi*wavelength_m*defocus_m*rho2)
    kernel=abs(np.fft.fft2(pupil))**2
    return np.fft.fftshift(kernel/kernel.sum())

def defocus(image,defocus_m,na=.25,pixel_m=.35e-6):
    """Convolve a thin-object estimate, with padded edges and per-channel wavelengths."""
    a=np.asarray(image.convert('RGB'),dtype=float)/255
    # Work in linear intensity instead of convolving gamma-encoded RGB.
    a=np.where(a<=.04045,a/12.92,((a+.055)/1.055)**2.4);pad=96;a=np.pad(a,((pad,pad),(pad,pad),(0,0)),mode='reflect')
    out=[]
    for c,lam in enumerate((620e-9,540e-9,460e-9)):
        k=psf(a.shape[:2],defocus_m,na,lam,pixel_m)
        out.append(np.fft.ifft2(np.fft.fft2(a[:,:,c])*np.fft.fft2(np.fft.ifftshift(k))).real)
    a=np.clip(np.stack(out,axis=-1)[pad:-pad,pad:-pad],0,1);a=np.where(a<=.0031308,12.92*a,1.055*a**(1/2.4)-.055)
    return Image.fromarray(np.uint8(np.clip(a*255,0,255)))

def specimen(seed=0,size=512):
    rng=np.random.default_rng(seed);im=Image.new('RGB',(size,size),(91,92,121));d=ImageDraw.Draw(im)
    for _ in range(32):
        x,y=rng.uniform(20,size-20,2);r=rng.uniform(5,28);pts=[]
        for ang in np.linspace(0,2*np.pi,6,endpoint=False):pts.append((x+r*np.cos(ang),y+r*np.sin(ang)))
        d.polygon(pts,fill=tuple(int(v) for v in rng.uniform([64,57,102],[131,120,159])),outline=(147,143,170))
    for x in range(80,size-70,70):
        for y in (60,size-85):
            d.rectangle((x,y,x+27,y+25),fill=(193,166,98));d.line((x+13,y+12,x+13,size/2),fill=(201,186,130),width=2)
    for x in (40,size-40):
        for y in (40,size-40):d.line((x-9,y,x+9,y),fill=(213,206,166),width=2);d.line((x,y-9,x,y+9),fill=(213,206,166),width=2)
    return im
if __name__=='__main__':
    from pathlib import Path
    root=Path(__file__).resolve().parents[1]/'demos/optics';root.mkdir(parents=True,exist_ok=True)
    source=specimen();source.save(root/'synthetic_specimen.png')
    for z in (0,2,5,12,25):defocus(source,z*1e-6).save(root/('defocus_%02dum.png'%z))
