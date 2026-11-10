namespace Duckling;

public static class Versions
{
    /// <summary>Numeric comparison of dotted versions ("1.0.10" is above "1.0.9").</summary>
    public static int Compare(string a, string b)
    {
        var x = a.Split('.'); var y = b.Split('.');
        for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            long p = i < x.Length && long.TryParse(x[i], out var px) ? px : 0;
            long q = i < y.Length && long.TryParse(y[i], out var qy) ? qy : 0;
            if (p != q) return p.CompareTo(q);
        }
        return 0;
    }
}
